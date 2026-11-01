// The capture lease check, in one command from the repo root:
//
//   node .agents/skills/verify-capture-lease/scripts/check.mjs [--only model|conformance|mutants] [--traces N]
//
// 1. Model check: TLC checks every rule of model/checks.json on each config and compares the
//    verdicts with the expected ones. Every counterexample is replayed on the real code.
// 2. Conformance: TLC draws random behaviors of the model; each one is replayed on the real store
//    code (replay.mjs), which fails at the first step where the code and the model disagree.
// 3. Mutants: each broken copy of the model must break a rule, so the rules can fail.
//
// Exit 0 when every verdict matches model/checks.json, every replay follows the model and every
// mutant is caught. TLC outputs stay in the printed work directory for /pstack:statechart.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRANCHES, Divergence, parseTrace, replay } from './replay.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = path.join(SKILL, 'model');
const TLA2TOOLS = {
  version: '1.7.4',
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
  sha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
};

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const only = flag('--only');
const tracesOverride = flag('--traces') === undefined ? undefined : Number(flag('--traces'));
const runs = part => only === undefined || only === part;

const checks = JSON.parse(fs.readFileSync(path.join(MODEL, 'checks.json'), 'utf8'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-capture-lease-'));
const problems = [];
/** Model branches that some replay took on the real code. */
const covered = new Set();
/** Replays that did not follow the model: reported once each part ends, with the first one in full. */
let diverged = 0;
const say = line => console.log(line);

// ---------------------------------------------------------------------------------------------
// Tools

function javaCommand() {
  const java = process.env.JAVA ?? 'java';
  const probe = spawnSync(java, ['-version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(
      `No working Java at "${java}" (${(probe.stderr || probe.error?.message || '').trim()}). Install a JDK 11 or later ` +
        '(for example `mise use -g java@temurin-21` or `brew install --cask temurin`), or set JAVA to its java binary.'
    );
  }
  return java;
}

async function tla2toolsJar() {
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (process.env.TLA2TOOLS_JAR) {
    const actual = sha256(process.env.TLA2TOOLS_JAR);
    if (actual !== TLA2TOOLS.sha256) {
      say(`warning: TLA2TOOLS_JAR is not tla2tools ${TLA2TOOLS.version} (sha256 ${actual}); results may differ`);
    }
    return process.env.TLA2TOOLS_JAR;
  }
  const cacheDir = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'alv-formal');
  const jar = path.join(cacheDir, `tla2tools-${TLA2TOOLS.version}.jar`);
  if (fs.existsSync(jar) && sha256(jar) === TLA2TOOLS.sha256) return jar;
  say(`Downloading tla2tools ${TLA2TOOLS.version} to ${jar}`);
  const response = await fetch(TLA2TOOLS.url);
  if (!response.ok) throw new Error(`download of ${TLA2TOOLS.url} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== TLA2TOOLS.sha256)
    throw new Error(`${TLA2TOOLS.url} has sha256 ${actual}, expected ${TLA2TOOLS.sha256}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(jar, bytes);
  return jar;
}

let runCount = 0;
/**
 * Runs TLC in its own directory under workDir on a copy of the model. Returns the output text and its file.
 * Model checking uses every core: a verdict does not depend on the worker count. Simulation passes
 * `workers: 1`, so a seed draws the same traces on every machine.
 */
function tlc(tools, { module, cfgText, extra = [], label, moduleText, workers = 'auto' }) {
  const dir = path.join(workDir, `${String(++runCount).padStart(2, '0')}-${label}`);
  fs.cpSync(MODEL, dir, { recursive: true });
  if (moduleText !== undefined) fs.writeFileSync(path.join(dir, module), moduleText);
  fs.writeFileSync(path.join(dir, 'Run.cfg'), cfgText);
  const result = spawnSync(
    tools.java,
    [
      '-XX:+UseParallelGC',
      '-cp',
      tools.jar,
      'tlc2.TLC',
      '-workers',
      String(workers),
      '-metadir',
      path.join(dir, 'states'),
      '-config',
      'Run.cfg',
      ...extra,
      module
    ],
    { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const outFile = path.join(dir, 'tlc.out');
  fs.writeFileSync(outFile, text);
  return { text, outFile, dir };
}

// A rule is an INVARIANT or a PROPERTY (an action property, [][A]_vars) on one line of the cfg.
const RULE_LINE = /^(INVARIANTS?|PROPERTY|PROPERTIES)\s+/;

const rulesOf = cfgText =>
  cfgText
    .split('\n')
    .filter(line => RULE_LINE.test(line))
    .flatMap(line => {
      const kind = /^INVARIANT/.test(line) ? 'INVARIANTS' : 'PROPERTIES';
      return line
        .replace(RULE_LINE, '')
        .trim()
        .split(/\s+/)
        .map(name => ({ name, kind }));
    });

const withRules = (cfgText, rules) => {
  const lines = cfgText.split('\n').filter(line => !RULE_LINE.test(line));
  for (const kind of ['INVARIANTS', 'PROPERTIES']) {
    const names = rules.filter(rule => rule.kind === kind).map(rule => rule.name);
    if (names.length > 0) lines.push(`${kind} ${names.join(' ')}`);
  }
  return lines.join('\n');
};

/**
 * TLC's verdict on each rule of a config: it drops a broken rule and runs again, until the rest hold.
 * `firstBreak` stops at the first broken rule (mutants only need one).
 */
function verdicts(tools, { cfg, module, moduleText, label, firstBreak = false }) {
  const cfgText = fs.readFileSync(path.join(MODEL, cfg), 'utf8');
  let remaining = rulesOf(cfgText);
  const result = {};
  while (remaining.length > 0) {
    const run = tlc(tools, { module, cfgText: withRules(cfgText, remaining), label, moduleText });
    if (/Model checking completed\. No error has been found\./.test(run.text)) {
      const states = /^(\d+) states generated, (\d+) distinct states found/m.exec(run.text)?.[2];
      for (const { name } of remaining) result[name] = { verdict: 'holds', outFile: run.outFile, states };
      break;
    }
    const broken = /Error: (?:Invariant|Action property) (\w+) is violated/.exec(run.text)?.[1];
    if (!broken) {
      throw new Error(`TLC failed on ${cfg} (${run.outFile}):\n${run.text.split('\n').slice(-25).join('\n')}`);
    }
    result[broken] = { verdict: 'breaks', outFile: run.outFile };
    if (firstBreak) break;
    remaining = remaining.filter(rule => rule.name !== broken);
  }
  return result;
}

async function replayFile(file, label) {
  const states = parseTrace(fs.readFileSync(file, 'utf8'));
  const dir = path.join(workDir, `replay-${label}`);
  try {
    const outcome = await replay(states, { workDir: dir });
    for (const branch of outcome.branches) covered.add(branch);
    return { ok: true, outcome };
  } catch (error) {
    diverged += 1;
    return {
      ok: false,
      error: error instanceof Divergence ? `diverged: ${error.message}` : String(error.stack ?? error)
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The three parts

async function modelChecks(tools) {
  say('\n== Model check (TLC, every behavior within the bounds of each config)');
  const unreplayable = [];
  for (const check of checks.modelChecks) {
    const found = verdicts(tools, { cfg: check.cfg, module: check.module, label: check.cfg.replace('.cfg', '') });
    for (const [rule, expected] of Object.entries(check.expect)) {
      const got = found[rule];
      const verdict = got?.verdict ?? 'not checked';
      const tag = verdict === expected ? 'ok  ' : 'FAIL';
      const detail = verdict === 'holds' && got.states ? ` (${got.states} states)` : '';
      say(`${tag} ${check.cfg} ${rule}: ${verdict}${detail}, expected ${expected}  [${got?.outFile ?? '-'}]`);
      if (verdict !== expected) {
        problems.push(
          expected === 'holds'
            ? `${rule} breaks on ${check.cfg}: a new finding or a modeling error. Read ${got?.outFile} with /pstack:statechart; the replay below tells which.`
            : `${rule} was expected to break on ${check.cfg} (${check.finding ?? 'witness'}) and ${verdict}: if the code changed on purpose, update checks.json and the findings in SKILL.md.`
        );
      }
      if (got?.verdict === 'breaks') {
        const replayed = await replayFile(got.outFile, `${check.cfg}-${rule}`);
        if (replayed.ok) {
          const { outcome } = replayed;
          const stolen =
            outcome.stolenFrom.length > 0 ? `, lease stolen from process ${outcome.stolenFrom.join(', ')}` : '';
          say(
            `       real code follows the counterexample: ${outcome.steps} steps, capturing at the end: ${
              outcome.capturing.map(p => `process ${p}`).join(' and ') || 'none'
            }${stolen}`
          );
        } else {
          say(`       replay on the real code ${replayed.error}`);
          unreplayable.push(`${check.cfg} ${rule}: ${replayed.error}`);
        }
      }
    }
  }
  if (unreplayable.length > 0) {
    problems.push(
      `${unreplayable.length} TLC path(s) do not replay on the real code, so the model does not describe the code. ` +
        `If the code changed on purpose, update the model (SKILL.md); otherwise the change is the bug. First: ${unreplayable[0]}`
    );
  }
}

async function conformance(tools) {
  say('\n== Conformance (random model behaviors replayed step by step on the real store code)');
  for (const sim of checks.conformance) {
    const traces = tracesOverride ?? sim.traces;
    const cfgText = fs.readFileSync(path.join(MODEL, sim.cfg), 'utf8');
    const tracesDir = path.join(workDir, `traces-${sim.cfg.replace('.cfg', '')}`);
    fs.mkdirSync(tracesDir, { recursive: true });
    const run = tlc(tools, {
      module: sim.module,
      cfgText,
      label: `simulate-${sim.cfg.replace('.cfg', '')}`,
      workers: 1,
      extra: [
        '-simulate',
        `file=${path.join(tracesDir, 'trace')},num=${traces}`,
        '-depth',
        String(sim.depth),
        '-seed',
        String(sim.seed)
      ]
    });
    const files = fs
      .readdirSync(tracesDir)
      .filter(name => name.startsWith('trace_'))
      .sort();
    if (files.length === 0) throw new Error(`TLC wrote no traces for ${sim.cfg} (${run.outFile})`);
    let steps = 0;
    let failed = 0;
    let first;
    for (const name of files) {
      const replayed = await replayFile(path.join(tracesDir, name), `${sim.cfg}-${name}`);
      if (replayed.ok) {
        steps += replayed.outcome.steps;
      } else {
        failed += 1;
        first ??= `${path.join(tracesDir, name)} ${replayed.error}`;
      }
    }
    if (first) {
      say(`FAIL first: ${first}`);
      problems.push(
        `${failed}/${files.length} ${sim.cfg} traces do not replay on the real code. If the code changed on purpose, ` +
          `update the model (SKILL.md); otherwise the change is the bug. First: ${first}`
      );
    }
    say(
      `${failed === 0 ? 'ok  ' : 'FAIL'} ${sim.cfg}: ${files.length - failed}/${files.length} traces (${steps} steps) replayed`
    );
  }
}

function branchCoverage() {
  if (diverged > 0) {
    say(`\nBranch coverage skipped: ${diverged} replay(s) diverged.`);
    return;
  }
  const missing = BRANCHES.filter(branch => !covered.has(branch));
  say(
    `\nModel branches the real code took in some replay: ${BRANCHES.length - missing.length}/${BRANCHES.length}` +
      (missing.length > 0 ? `; never taken: ${missing.join('; ')}` : '')
  );
  if (only === undefined && missing.length > 0) {
    problems.push(
      `No replay took ${missing.join('; ')}: add a witness to Witness.tla or raise the conformance traces.`
    );
  }
}

function mutants(tools) {
  say(`\n== Mutants (each broken model must break a rule on its config, ${checks.mutants.cfg} unless named)`);
  const source = fs.readFileSync(path.join(MODEL, checks.mutants.module), 'utf8');
  for (const mutant of checks.mutants.list) {
    const occurrences = source.split(mutant.replace).length - 1;
    if (occurrences !== 1) {
      say(`FAIL ${mutant.name}: its text occurs ${occurrences} times in ${checks.mutants.module}`);
      problems.push(`Mutant "${mutant.name}" no longer applies to the model; update its text in checks.json.`);
      continue;
    }
    const found = verdicts(tools, {
      cfg: mutant.cfg ?? checks.mutants.cfg,
      module: checks.mutants.module,
      moduleText: source.replace(mutant.replace, mutant.with),
      label: `mutant-${checks.mutants.list.indexOf(mutant) + 1}`,
      firstBreak: true
    });
    const broken = Object.entries(found)
      .filter(([, value]) => value.verdict === 'breaks')
      .map(([rule]) => rule);
    say(
      `${broken.length > 0 ? 'ok  ' : 'FAIL'} ${mutant.name} (${mutant.code}): ${broken.length > 0 ? `breaks ${broken.join(', ')}` : 'no rule breaks'}`
    );
    if (broken.length === 0)
      problems.push(`Mutant "${mutant.name}" breaks no rule: the rules are too weak to catch it.`);
  }
}

// ---------------------------------------------------------------------------------------------

try {
  const tools = { java: javaCommand(), jar: await tla2toolsJar() };
  say(`TLC: tla2tools ${TLA2TOOLS.version}. Work directory: ${workDir}`);
  const started = Date.now();
  if (runs('model')) await modelChecks(tools);
  if (runs('conformance')) await conformance(tools);
  if (runs('mutants')) mutants(tools);
  if (runs('model') || runs('conformance')) branchCoverage();
  say(`\nFinished in ${Math.round((Date.now() - started) / 1000)} s. TLC outputs: ${workDir}`);
  if (problems.length > 0) {
    say(`\n${problems.length} problem(s):`);
    for (const problem of problems) say(`- ${problem}`);
    process.exit(1);
  }
  say('Every verdict matches model/checks.json.');
} catch (error) {
  console.error(error.stack ?? error);
  process.exit(2);
}
