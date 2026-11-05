import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LEASE, MARKER_OF_ANY_CHAIN_LENGTH } from './replay.mjs';

const [channelDir, root, username, object] = process.argv.slice(2);
const storeModule = pathToFileURL(
  path.resolve(import.meta.dirname, '../../../../packages/core/src/customLogs/events/store.ts')
).href;

let inSeq = 0;
let outSeq = 0;
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = ms => Atomics.wait(pause, 0, 0, ms);

function writeAtomic(file, value) {
  const temporary = `${file}.part`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

const emit = message => writeAtomic(path.join(channelDir, `out-${outSeq++}.json`), message);

function takeSync() {
  const file = path.join(channelDir, `in-${inSeq}.json`);
  while (!fs.existsSync(file)) sleepSync(1);
  inSeq += 1;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function takeAsync() {
  const file = path.join(channelDir, `in-${inSeq}.json`);
  while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 1));
  inSeq += 1;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let skewMs = 0;
const realNow = Date.now;
Date.now = () => realNow() + skewMs;

let phase = 'idle';
const KNOWN_CALLERS = ['reclaimDeadLease', 'tryAcquireLease'];

function targetOf(file) {
  const base = path.basename(String(file));
  if (base === LEASE) return { target: 'lease' };
  const marker = MARKER_OF_ANY_CHAIN_LENGTH.exec(base);
  return marker ? { target: 'marker', markerOf: marker[1] } : undefined;
}

function callerOf(stack) {
  for (const line of String(stack).split('\n')) {
    const name = KNOWN_CALLERS.find(candidate => line.includes(` ${candidate} `) || line.includes(`.${candidate} `));
    if (name) return name;
  }
  return undefined;
}

// Gates block synchronously, because pidLiveness() calls process.kill synchronously and cannot await.
function gate(info) {
  emit({ type: 'gate', phase, caller: callerOf(new Error().stack), ...info });
  const message = takeSync();
  if (!message.go) throw new Error(`expected go at a gate, got ${JSON.stringify(message)}`);
  if (message.skewMs) skewMs += message.skewMs;
}

const promises = fs.promises;
const original = { link: promises.link, lstat: promises.lstat, unlink: promises.unlink };
let lstatAfterFailedLink;

promises.link = async (source, destination) => {
  const target = targetOf(destination);
  if (!target) return original.link(source, destination);
  const token = JSON.parse(fs.readFileSync(source, 'utf8')).token;
  gate({ op: 'link', ...target, token });
  try {
    return await original.link(source, destination);
  } catch (error) {
    if (error?.code === 'EEXIST') lstatAfterFailedLink = String(destination);
    throw error;
  }
};

promises.lstat = async (file, ...rest) => {
  const target = targetOf(file);
  if (target && lstatAfterFailedLink === String(file)) {
    lstatAfterFailedLink = undefined;
  } else if (target) {
    gate({ op: 'lstat', ...target });
  }
  return original.lstat(file, ...rest);
};

promises.unlink = async file => {
  const target = targetOf(file);
  if (target) gate({ op: 'unlink', ...target });
  return original.unlink(file);
};

const originalKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal === 0) gate({ op: 'kill', pid });
  return originalKill(pid, signal);
};

const CHECKPOINT = {
  orgId: '00D000000000000AAA',
  transport: 'cometd',
  channel: `/event/${object}`,
  cursor: 'cometd:1',
  lastEvent: { createdDate: '2026-01-01T00:00:00.000Z', uuid: '00000000-0000-4000-8000-000000000000' }
};

async function main() {
  const { openEventStore, LeaseLostError } = await import(storeModule);
  const store = openEventStore({ root, username, object });
  let writer;
  emit({ type: 'ready', pid: process.pid, eventsRoot: store.eventsRoot });
  for (;;) {
    const message = await takeAsync();
    if (message.cmd === 'acquire') {
      phase = 'acquire';
      const attempt = await store.openWriter('cli');
      if ('writer' in attempt) {
        writer = attempt.writer;
        emit({ type: 'result', kind: 'acquired' });
      } else {
        emit({ type: 'result', kind: 'heldBy', pid: attempt.heldBy.pid });
      }
    } else if (message.cmd === 'fence') {
      phase = 'fence';
      try {
        await writer.advance(CHECKPOINT);
        emit({ type: 'result', kind: 'advanced' });
        phase = 'idle';
        continue;
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
      }
      phase = 'release';
      await writer.release();
      writer = undefined;
      emit({ type: 'result', kind: 'released', after: 'leaseLost' });
    } else if (message.cmd === 'release') {
      phase = 'release';
      await writer.release();
      writer = undefined;
      emit({ type: 'result', kind: 'released' });
    } else {
      throw new Error(`unknown command ${JSON.stringify(message)}`);
    }
    phase = 'idle';
  }
}

main().catch(error => {
  emit({ type: 'error', message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
  process.exit(1);
});
