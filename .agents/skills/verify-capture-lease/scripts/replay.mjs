import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPTS, '../../../..');
const CORE_PACKAGE = path.join(REPO_ROOT, 'packages', 'core');
const CHILD = path.join(SCRIPTS, 'leaseChild.mjs');

const NONE = 0;
const DEAD_HOLDER = 98;
const DEAD_ELECTOR = 99;
export const LEASE = 'capture.lease';
export const MARKER_OF_ANY_CHAIN_LENGTH = /^capture\.lease\.reclaim-([0-9a-f]{16}(?:-[0-9a-f]{16})*)$/;

export function parseValue(text) {
  let at = 0;
  const skip = () => {
    while (at < text.length && /\s/.test(text[at])) at += 1;
  };
  const expect = token => {
    skip();
    if (!text.startsWith(token, at)) throw new Error(`expected ${token} at ${at} in ${text}`);
    at += token.length;
  };
  const value = () => {
    skip();
    if (text.startsWith('<<', at)) {
      at += 2;
      const result = {};
      let index = 1;
      skip();
      if (text.startsWith('>>', at)) {
        at += 2;
        return result;
      }
      for (;;) {
        result[index++] = value();
        skip();
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        expect('>>');
        return result;
      }
    }
    if (text[at] === '{') {
      at += 1;
      const result = [];
      skip();
      if (text[at] === '}') {
        at += 1;
        return result;
      }
      for (;;) {
        result.push(value());
        skip();
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        expect('}');
        return result;
      }
    }
    if (text[at] === '(') {
      at += 1;
      const result = {};
      for (;;) {
        const key = value();
        expect(':>');
        result[key] = value();
        skip();
        if (text.startsWith('@@', at)) {
          at += 2;
          continue;
        }
        expect(')');
        return result;
      }
    }
    if (text[at] === '"') {
      const end = text.indexOf('"', at + 1);
      const result = text.slice(at + 1, end);
      at = end + 1;
      return result;
    }
    if (text.startsWith('TRUE', at)) {
      at += 4;
      return true;
    }
    if (text.startsWith('FALSE', at)) {
      at += 5;
      return false;
    }
    const number = /^-?\d+/.exec(text.slice(at));
    if (number) {
      at += number[0].length;
      return Number(number[0]);
    }
    throw new Error(`cannot parse TLC value at ${at}: ${text.slice(at, at + 40)}`);
  };
  const result = value();
  skip();
  if (at !== text.length) throw new Error(`trailing text after TLC value: ${text.slice(at)}`);
  return result;
}

function parseState(body) {
  const state = {};
  const parts = body.split(/^\/\\ (\w+) = /m);
  for (let index = 1; index < parts.length; index += 2) state[parts[index]] = parseValue(parts[index + 1].trim());
  return state;
}

export function parseTrace(text) {
  const counterexample = /^State (\d+): (?:<(\w+)[^>]*>|(Stuttering|Back to state.*))?/gm;
  const simulated = /^STATE_(\d+) ==/gm;
  const marks = [];
  for (const match of text.matchAll(counterexample)) {
    if (match[3]) throw new Error(`replay handles safety counterexamples only, not "${match[3]}"`);
    marks.push({ index: match.index, header: match[0].length, action: match[2] });
  }
  if (marks.length === 0) {
    for (const match of text.matchAll(simulated)) marks.push({ index: match.index, header: match[0].length });
  }
  if (marks.length === 0)
    throw new Error('no states found: expected TLC output with a counterexample or a -simulate trace');
  return marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : text.length;
    const body = text.slice(mark.index + mark.header, end).split(/\n\s*\n/)[0];
    return { action: mark.action, vars: parseState(body) };
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function writeAtomic(file, value) {
  const temporary = `${file}.part`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

class Child {
  constructor(label, channelDir, args) {
    this.label = label;
    this.channelDir = channelDir;
    this.inSeq = 0;
    this.outSeq = 0;
    this.stderr = '';
    this.exited = false;
    fs.mkdirSync(channelDir, { recursive: true });
    this.process = spawn(process.execPath, ['--import', 'tsx', CHILD, channelDir, ...args], {
      cwd: CORE_PACKAGE,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    this.process.stderr.on('data', chunk => (this.stderr += chunk));
    this.exit = new Promise(resolve => this.process.once('exit', () => resolve((this.exited = true))));
  }

  send(message) {
    writeAtomic(path.join(this.channelDir, `in-${this.inSeq++}.json`), message);
  }

  async next(timeoutMs = 15_000) {
    const file = path.join(this.channelDir, `out-${this.outSeq}.json`);
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file)) {
      if (this.exited) throw new Error(`${this.label} exited before its next message. stderr:\n${this.stderr}`);
      if (Date.now() > deadline) {
        throw new Error(
          `${this.label} sent nothing for ${timeoutMs} ms: the code did not reach a lease call the model expects`
        );
      }
      await sleep(1);
    }
    this.outSeq += 1;
    const message = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (message.type === 'error') throw new Error(`${this.label} threw: ${message.stack || message.message}`);
    this.status = message;
    return message;
  }

  async crash() {
    this.process.kill('SIGKILL');
    await this.exit;
    this.status = { type: 'dead' };
  }
}

function deadPid() {
  const result = spawnSync(process.execPath, ['-e', '']);
  if (!result.pid) throw new Error('could not spawn a short-lived process for a dead pid');
  return result.pid;
}

const randomToken = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const ownerRecord = (pid, token) =>
  JSON.stringify({ version: 1, pid, token, host: os.hostname(), surface: 'cli', startedAt: new Date(0).toISOString() });

const GATES = {
  createLease: { op: 'link', target: 'lease', phase: 'acquire', caller: 'tryAcquireLease' },
  readLease: { op: 'lstat', target: 'lease', phase: 'acquire', caller: 'tryAcquireLease' },
  judgeHolder: { op: 'kill', phase: 'acquire', caller: 'tryAcquireLease', pidOf: 'rec' },
  createMarker: { op: 'link', target: 'marker', phase: 'acquire', caller: 'reclaimDeadLease' },
  electedReadLease: { op: 'lstat', target: 'lease', phase: 'acquire', caller: 'reclaimDeadLease' },
  electedUnlinkLease: { op: 'unlink', target: 'lease', phase: 'acquire', caller: 'reclaimDeadLease' },
  unlinkPassedMarker: { op: 'unlink', target: 'marker', phase: 'acquire', caller: 'reclaimDeadLease', passed: true },
  unlinkOwnMarker: { op: 'unlink', target: 'marker', phase: 'acquire', caller: 'reclaimDeadLease' },
  readMarker: { op: 'lstat', target: 'marker', phase: 'acquire', caller: 'reclaimDeadLease' },
  judgeElector: { op: 'kill', phase: 'acquire', caller: 'reclaimDeadLease', pidOf: 'mrec' },
  waitLease: { op: 'lstat', target: 'lease', phase: 'acquire', caller: 'reclaimDeadLease' },
  releaseRead: { op: 'lstat', target: 'lease', phase: 'release' },
  releaseUnlink: { op: 'unlink', target: 'lease', phase: 'release' }
};

export const BRANCHES = [
  'user deletes capture.lease',
  'crash',
  'idle -> createLease',
  'createLease -> capturing',
  'createLease -> readLease',
  'readLease -> createLease',
  'readLease -> judgeHolder',
  'judgeHolder -> idle',
  'judgeHolder -> createMarker',
  'createMarker -> electedReadLease',
  'createMarker -> readMarker',
  'electedReadLease -> electedUnlinkLease',
  'electedReadLease -> unlinkPassedMarker',
  'electedReadLease -> unlinkOwnMarker',
  'electedUnlinkLease -> unlinkPassedMarker',
  'electedUnlinkLease -> unlinkOwnMarker',
  'unlinkPassedMarker -> unlinkPassedMarker',
  'unlinkPassedMarker -> unlinkOwnMarker',
  'unlinkOwnMarker -> createLease',
  'readMarker -> createLease',
  'readMarker -> judgeElector',
  'judgeElector -> createMarker',
  'judgeElector -> waitLease',
  'waitLease -> createLease',
  'waitLease -> idle',
  'capturing -> releaseRead (finish)',
  'capturing -> releaseRead (fence sees loss)',
  'releaseRead -> releaseUnlink',
  'releaseRead -> idle',
  'releaseUnlink -> idle'
];

function branchOf(before, after, p) {
  if (before.alive[p] && !after.alive[p]) return 'crash';
  const edge = `${before.pc[p]} -> ${after.pc[p]}`;
  if (before.pc[p] !== 'capturing') return edge;
  return `${edge} (${before.lease !== before.tok[p] ? 'fence sees loss' : 'finish'})`;
}

const SETTLE_SKEW_MS = 1_100;

const modelMarkerName = chain => (chain.length === 1 ? chain : [chain[0], chain[chain.length - 1]]);

class Divergence extends Error {}

const describeStatus = status =>
  status.type === 'gate'
    ? `stopped before ${status.op} ${status.target ?? `pid ${status.pid}`}${status.markerOf ? ` reclaim-${status.markerOf}` : ''} (${status.phase}${status.caller ? `, in ${status.caller}` : ''})`
    : status.type === 'result'
      ? `returned ${status.kind}`
      : status.type;

export async function replay(states, { workDir, keep = false, log = () => undefined } = {}) {
  const first = states[0].vars;
  const procs = Object.keys(first.pc).map(Number);
  const root = path.join(workDir, 'root');
  fs.mkdirSync(root, { recursive: true });
  const username = 'replay@example.com';
  const object = 'App_Log__e';
  const children = new Map(
    procs.map(p => [p, new Child(`process ${p}`, path.join(workDir, `channel-${p}`), [root, username, object])])
  );
  const realTokens = new Map();
  const realPids = new Map();
  try {
    let objectDir;
    for (const [p, child] of children) {
      const ready = await child.next(30_000);
      realPids.set(p, ready.pid);
      objectDir = ready.eventsRoot;
    }
    const leaseFile = path.join(objectDir, LEASE);

    if (first.minter[1] === DEAD_HOLDER || first.minter[2] === DEAD_ELECTOR) {
      fs.mkdirSync(objectDir, { recursive: true });
      for (const [modelToken, modelPid] of [
        [1, DEAD_HOLDER],
        [2, DEAD_ELECTOR]
      ]) {
        realTokens.set(modelToken, randomToken());
        realPids.set(modelPid, deadPid());
      }
      if (first.lease === 1) fs.writeFileSync(leaseFile, ownerRecord(realPids.get(DEAD_HOLDER), realTokens.get(1)));
      if (first.markers.length > 0) {
        fs.writeFileSync(
          path.join(objectDir, `${LEASE}.reclaim-${realTokens.get(1)}`),
          ownerRecord(realPids.get(DEAD_ELECTOR), realTokens.get(2))
        );
      }
    }

    const realToken = t => {
      if (!realTokens.has(t)) throw new Error(`model token ${t} has no real token yet`);
      return realTokens.get(t);
    };
    const realName = tuple => Object.values(tuple).map(realToken).join('-');

    const readDisk = () => {
      const tokenIn = file => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8')).token;
        } catch (error) {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }
      };
      const markers = {};
      for (const name of fs.existsSync(objectDir) ? fs.readdirSync(objectDir) : []) {
        const match = MARKER_OF_ANY_CHAIN_LENGTH.exec(name);
        if (match) markers[match[1]] = tokenIn(path.join(objectDir, name));
      }
      return { lease: tokenIn(leaseFile), markers };
    };

    const checkDisk = (vars, where) => {
      const disk = readDisk();
      const wantLease = vars.lease === NONE ? undefined : realToken(vars.lease);
      const wantMarkers = {};
      for (const [tuple, elector] of vars.markers.map(marker => [marker[1], marker[2]])) {
        wantMarkers[realName(tuple)] = realToken(elector);
      }
      const tokenName = hex => {
        const found = [...realTokens].find(([, real]) => real === hex);
        return found ? `token ${found[0]}` : hex === undefined ? 'absent' : `unknown ${hex}`;
      };
      const name = hex => (hex === undefined ? 'absent' : hex.split('-').map(tokenName).join('-'));
      if (disk.lease !== wantLease) {
        throw new Divergence(`${where}: capture.lease holds ${name(disk.lease)}, the model says ${name(wantLease)}`);
      }
      const keys = new Set([...Object.keys(disk.markers), ...Object.keys(wantMarkers)]);
      for (const key of keys) {
        if (disk.markers[key] !== wantMarkers[key]) {
          throw new Divergence(
            `${where}: capture.lease.reclaim-<${name(key)}> holds ${name(disk.markers[key])}, the model says ${name(wantMarkers[key])}`
          );
        }
      }
    };

    const checkProcess = (p, vars, where) => {
      const child = children.get(p);
      const status = child.status;
      const pc = vars.pc[p];
      const fail = expected => {
        throw new Divergence(
          `${where}: process ${p} ${describeStatus(status)}; the model has it at ${pc} (${expected})`
        );
      };
      if (!vars.alive[p]) {
        if (status.type !== 'dead') fail('dead');
        return;
      }
      if (pc === 'idle') {
        const idle =
          status.type === 'ready' || (status.type === 'result' && ['heldBy', 'released'].includes(status.kind));
        if (!idle) fail('no lease call in flight, not capturing');
        return;
      }
      if (pc === 'capturing') {
        if (!(status.type === 'result' && status.kind === 'acquired')) fail('holding the lease');
        return;
      }
      const gate = GATES[pc];
      if (!gate) throw new Error(`replay.mjs has no gate for model pc "${pc}"; update GATES`);
      const same =
        status.type === 'gate' &&
        status.op === gate.op &&
        status.phase === gate.phase &&
        (gate.target === undefined || status.target === gate.target) &&
        (gate.caller === undefined || status.caller === gate.caller);
      if (!same) fail(describeStatus({ type: 'gate', ...gate }));
      if (gate.target === 'marker') {
        const chain = Object.values(vars.chain[p]);
        const upTo = gate.passed ? chain.slice(0, vars.done[p] + 1) : chain;
        const name = modelMarkerName(upTo);
        if (status.markerOf !== realName(name)) fail(`marker reclaim-<${name.join('-')}>`);
      }
      if (gate.op === 'link' && status.token !== realToken(vars.tok[p])) fail(`its own token ${vars.tok[p]}`);
      if (gate.pidOf) {
        const modelPid = vars.minter[vars[gate.pidOf][p]];
        if (status.pid !== realPids.get(modelPid)) fail(`checking the pid of model process ${modelPid}`);
      }
    };

    const checkAll = (vars, where) => {
      for (const p of procs) checkProcess(p, vars, where);
      checkDisk(vars, where);
    };

    checkAll(first, 'state 1');
    const branches = new Set();
    for (let index = 1; index < states.length; index += 1) {
      const before = states[index - 1].vars;
      const after = states[index].vars;
      const acting = procs.filter(
        p =>
          before.pc[p] !== after.pc[p] ||
          before.alive[p] !== after.alive[p] ||
          before.tok[p] !== after.tok[p] ||
          before.rec[p] !== after.rec[p] ||
          before.mrec[p] !== after.mrec[p] ||
          before.done[p] !== after.done[p] ||
          JSON.stringify(before.chain[p]) !== JSON.stringify(after.chain[p])
      );
      if (acting.length === 0 && before.lease !== NONE && after.lease === NONE) {
        const where = `state ${index + 1} (UserDeletesLease)`;
        log(`  ${where}`);
        branches.add('user deletes capture.lease');
        fs.unlinkSync(leaseFile);
        checkAll(after, where);
        continue;
      }
      if (acting.length !== 1) throw new Error(`state ${index + 1}: expected one acting process, found ${acting}`);
      const p = acting[0];
      const child = children.get(p);
      const action = states[index].action ?? `${before.pc[p]} -> ${after.pc[p]}`;
      const where = `state ${index + 1} (${action}, process ${p})`;
      log(`  ${where}`);
      branches.add(branchOf(before, after, p));
      if (before.alive[p] && !after.alive[p]) {
        await child.crash();
      } else if (before.pc[p] === 'idle') {
        child.send({ cmd: 'acquire' });
        await child.next();
        if (child.status.type === 'gate' && child.status.op === 'link')
          realTokens.set(after.tok[p], child.status.token);
      } else if (before.pc[p] === 'capturing') {
        if (before.lease !== before.tok[p]) {
          child.send({ cmd: 'fence' });
          const fence = await child.next();
          if (!(fence.type === 'gate' && fence.phase === 'fence' && fence.op === 'lstat' && fence.target === 'lease')) {
            throw new Divergence(`${where}: writer.advance ${describeStatus(fence)} before stillHeld() read the lease`);
          }
          child.send({ go: true });
          await child.next();
        } else {
          child.send({ cmd: 'release' });
          await child.next();
        }
      } else {
        const timesOut = before.pc[p] === 'waitLease' && after.pc[p] === 'idle';
        child.send({ go: true, ...(timesOut ? { skewMs: SETTLE_SKEW_MS } : {}) });
        await child.next();
      }
      checkAll(after, where);
    }

    const last = states[states.length - 1].vars;
    const disk = readDisk();
    const capturing = procs.filter(
      p => children.get(p).status.type === 'result' && children.get(p).status.kind === 'acquired'
    );
    return {
      steps: states.length - 1,
      branches,
      capturing,
      leaseOnDisk: disk.lease,
      stolenFrom: capturing.filter(p => disk.lease !== realToken(last.tok[p]))
    };
  } finally {
    await Promise.all(
      [...children.values()].map(child => (child.exited ? undefined : (child.process.kill('SIGKILL'), child.exit)))
    );
    if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export { Divergence };

if (fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node replay.mjs <trace-file> [--keep]');
    process.exit(2);
  }
  const states = parseTrace(fs.readFileSync(file, 'utf8'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-lease-replay-'));
  try {
    const outcome = await replay(states, { workDir, keep: flags.includes('--keep'), log: line => console.log(line) });
    console.log(
      `Replayed ${outcome.steps} steps on the real code. Capturing: ${outcome.capturing.map(p => `process ${p}`).join(', ') || 'none'}.` +
        (outcome.stolenFrom.length > 0
          ? ` Lease stolen from a live capturer: ${outcome.stolenFrom.map(p => `process ${p}`).join(', ')}.`
          : '')
    );
    if (flags.includes('--keep')) console.log(`Kept ${workDir}`);
  } catch (error) {
    console.error(error instanceof Divergence ? `DIVERGED: ${error.message}` : error);
    process.exit(1);
  }
}
