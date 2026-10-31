import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveElectivusPluginInvocation } from '../cli/utils/cli';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EVENTS_ORG_SCRIPT = path.join(REPO_ROOT, 'scripts', 'events-org.mjs');
const TRANSPORT_PROBE = path.join(__dirname, 'eventsTransportProbe.mjs');

export const EVENTS_ORG_ALIAS = 'alv-events';
export const RESTRICTED_ALIAS = 'alv-events-restricted';
export const EVENT_SOURCE_ID = 'alv-events';
export const EVENT_OBJECTS = {
  log: 'ALV_Test_Log__e',
  replay: 'ALV_Test_Replay__e',
  backlog: 'ALV_Test_Backlog__e'
} as const;
export type EventObject = (typeof EVENT_OBJECTS)[keyof typeof EVENT_OBJECTS];

/** Deliveries one capture may spend in a scenario. The org's 25,000 a day are shared by every run. */
export const DELIVERIES_PER_RUN = 600;

const sfBinary = (): string => process.env.ALV_SF_BIN_PATH || 'sf';

/**
 * True when this machine has the `alv-events` scratch org authenticated. Pool-only CI has not, so the events
 * specs skip there without any other configuration.
 */
export function eventsOrgConfigured(): boolean {
  const result = spawnSync(sfBinary(), ['org', 'display', '--target-org', EVENTS_ORG_ALIAS, '--json'], {
    encoding: 'utf8',
    timeout: 90_000
  });
  return !result.error && result.status === 0;
}

export function lastJsonLine(stdout: string): any {
  const line = stdout
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`No JSON line in output: ${stdout.slice(0, 300)}`);
  return JSON.parse(line);
}

async function runEventsOrg(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [EVENTS_ORG_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    timeout: 5 * 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

export type PublishResult = {
  alias: string;
  object: EventObject;
  published: number;
  runTag: string;
  transactionId: string;
};

/** Publishes synthetic events to the events org through `scripts/events-org.mjs`, which refuses any other alias. */
export async function publishEvents(options: {
  count: number;
  transactionId: string;
  object?: EventObject;
  level?: string;
}): Promise<PublishResult> {
  const args = ['publish', '--count', String(options.count), '--transaction-id', options.transactionId];
  if (options.object) args.push('--object', options.object);
  if (options.level) args.push('--level', options.level);
  return lastJsonLine(await runEventsOrg(args));
}

export type Allowance = { remaining: number; max: number };

export async function readAllowance(): Promise<Allowance> {
  const stdout = await runEventsOrg(['limits']);
  const limits = JSON.parse(stdout.slice(stdout.indexOf('{'))).limits.DailyDeliveredPlatformEvents;
  return { remaining: limits.remaining, max: limits.max };
}

/**
 * Reads the allowance until two readings a minute apart agree. The counter in /limits lags a delivery by several
 * minutes, so a reading taken right after a run understates what it spent.
 */
export async function settledAllowance(options: { maxWaitMs?: number; intervalMs?: number } = {}): Promise<Allowance> {
  const intervalMs = options.intervalMs ?? 60_000;
  const deadline = Date.now() + (options.maxWaitMs ?? 8 * 60_000);
  let previous = await readAllowance();
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const current = await readAllowance();
    if (current.remaining === previous.remaining) return current;
    previous = current;
  }
  return previous;
}

export type EventSourceFields = Partial<
  Record<'time' | 'message' | 'level' | 'user' | 'transactionId' | 'order' | 'requestId', string>
>;

/** The six roles `ALV_Test_Log__e` and its siblings map, and nothing else: Request_Id__c and Payload__c stay unmapped. */
const BASE_FIELDS: EventSourceFields = {
  time: 'Logged_At__c',
  message: 'Message__c',
  level: 'Level__c',
  user: 'Username__c',
  transactionId: 'Transaction_Id__c',
  order: 'Sequence__c'
};

export function eventSourceDefinition(options: { object: EventObject; extraEvent?: Record<string, unknown> }) {
  return {
    id: EVENT_SOURCE_ID,
    label: 'ALV events',
    event: { object: options.object, fields: BASE_FIELDS, ...options.extraEvent }
  };
}

export type EventsProject = { dir: string; cleanup(): Promise<void> };

/** A temporary Salesforce project with one event source, so every scenario owns its store. */
export async function createEventsProject(options: {
  object: EventObject;
  extraEvent?: Record<string, unknown>;
  gitInit?: boolean;
}): Promise<EventsProject> {
  const dir = await mkdtemp(path.join(tmpdir(), 'alv-events-e2e-'));
  await writeFile(
    path.join(dir, 'sfdx-project.json'),
    JSON.stringify(
      {
        packageDirectories: [{ path: 'force-app', default: true }],
        namespace: '',
        sourceApiVersion: '65.0',
        plugins: { electivus: { customLogs: { sources: [eventSourceDefinition(options)] } } }
      },
      null,
      2
    )
  );
  await mkdir(path.join(dir, 'force-app'), { recursive: true });
  if (options.gitInit) {
    const init = spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export type CliOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The `sf --json` envelope, when stdout holds one. */
  json?: any;
  durationMs: number;
};

type Line = { atMs: number; text: string };

/** A long-running `sf electivus` command whose output can be waited on line by line. */
export class CliProcess {
  readonly stdoutLines: Line[] = [];
  readonly stderrLines: Line[] = [];
  readonly startedAt = Date.now();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; atMs: number }>;
  private readonly child: ChildProcess;
  private stdoutRest = '';
  private stderrRest = '';
  private raw = { stdout: '', stderr: '' };

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding('utf8').on('data', chunk => {
      this.raw.stdout += chunk;
      this.stdoutRest = this.collect(this.stdoutRest + chunk, this.stdoutLines);
    });
    child.stderr?.setEncoding('utf8').on('data', chunk => {
      this.raw.stderr += chunk;
      this.stderrRest = this.collect(this.stderrRest + chunk, this.stderrLines);
    });
    this.exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, atMs: Date.now() }));
    });
  }

  static start(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): CliProcess {
    const env = { ...process.env, ...options.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const invocation = resolveElectivusPluginInvocation({ env });
    return new CliProcess(
      spawn(invocation.command, [...invocation.args, ...args], {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get stdout(): string {
    return this.raw.stdout;
  }

  get stderr(): string {
    return this.raw.stderr;
  }

  private collect(buffered: string, into: Line[]): string {
    const parts = buffered.split('\n');
    const rest = parts.pop() ?? '';
    for (const text of parts) into.push({ atMs: Date.now(), text: text.replace(/\r$/, '') });
    return rest;
  }

  /** Resolves with the first stderr line that matches, whenever it arrives, and rejects after `timeoutMs`. */
  waitForStderr(pattern: RegExp, timeoutMs = 60_000): Promise<Line> {
    return this.waitFor(this.stderrLines, pattern, timeoutMs, 'stderr');
  }

  /** Resolves once `count` stdout lines match. */
  async waitForStdoutLines(pattern: RegExp, count: number, timeoutMs = 120_000): Promise<Line[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matches = this.stdoutLines.filter(line => pattern.test(line.text));
      if (matches.length >= count) return matches;
      if (Date.now() > deadline) {
        throw new Error(`Only ${matches.length} of ${count} stdout lines matched ${pattern}; stdout:\n${this.stdout}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async waitFor(lines: Line[], pattern: RegExp, timeoutMs: number, label: string): Promise<Line> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = lines.find(line => pattern.test(line.text));
      if (match) return match;
      if (Date.now() > deadline)
        throw new Error(`No ${label} line matched ${pattern}; ${label}:\n${this.raw[label as 'stdout' | 'stderr']}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  interrupt(): void {
    this.child.kill('SIGINT');
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }

  async finished(timeoutMs = 60_000): Promise<CliOutcome> {
    const timer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    try {
      const { code, atMs } = await this.exited;
      return outcomeOf(code, this.raw.stdout, this.raw.stderr, atMs - this.startedAt);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What a finished command reports it spent: `delivered` in the JSON result, or the `Delivered N` line of `--follow`. */
export function deliveredBy(outcome: CliOutcome): number {
  const reported = outcome.json?.result?.delivered ?? outcome.stderr.match(/Delivered (\d+), stored/)?.[1];
  return Number(reported ?? 0);
}

function envelopeOf(text: string): any {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  try {
    return JSON.parse(plain.slice(plain.indexOf('{')));
  } catch {
    return undefined;
  }
}

function outcomeOf(exitCode: number | null, stdout: string, stderr: string, durationMs: number): CliOutcome {
  return { exitCode, stdout, stderr, json: envelopeOf(stdout) ?? envelopeOf(stderr), durationMs };
}

/** Runs a command to its end. */
export async function runCli(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CliOutcome> {
  return CliProcess.start(args, options).finished(options.timeoutMs ?? 5 * 60_000);
}

export type TransportProbeResult = {
  outcome?: string;
  afterMs?: number;
  failure?: { kind: string; message?: string };
  held?: number;
  refusal?: { channel: string; error: string; failureReason?: string } | null;
};

export async function probeSubscribe(alias: string, object: EventObject): Promise<TransportProbeResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [TRANSPORT_PROBE, 'subscribe', '--alias', alias, '--object', object],
    { cwd: REPO_ROOT, timeout: 90_000 }
  );
  return lastJsonLine(stdout);
}

/** Streaming clients held open until Salesforce refuses one. `release()` closes them. */
export async function holdClientsUntilRefused(): Promise<{ result: TransportProbeResult; release(): Promise<void> }> {
  const child = spawn(process.execPath, [TRANSPORT_PROBE, 'hold', '--alias', EVENTS_ORG_ALIAS, '--max', '25'], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const result = await new Promise<TransportProbeResult>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`The hold probe printed nothing: ${buffered}`)), 3 * 60_000);
    child.stdout?.setEncoding('utf8').on('data', chunk => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      clearTimeout(timer);
      resolve(lastJsonLine(buffered));
    });
    child.once('exit', code => reject(new Error(`The hold probe exited with ${code} before it reported`)));
  });
  return {
    result,
    release: async () => {
      child.stdin?.end();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
      child.kill('SIGKILL');
    }
  };
}

export type StoredEvent = {
  v: number;
  id: string;
  uuid: string;
  seq: number;
  replayId: string;
  createdDate: string;
  receivedAt: string;
  payload: Record<string, unknown>;
};

async function filesUnder(dir: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(entryPath, suffix)));
    else if (entry.name.endsWith(suffix)) found.push(entryPath);
  }
  return found;
}

/** Every event line on disk, copies included: the files are the store's public contract. */
export async function readStoredEvents(eventsRoot: string): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  for (const file of await filesUnder(eventsRoot, '.ndjson')) {
    if (path.basename(file).startsWith('gaps.')) continue;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

export type Checkpoint = {
  version: number;
  orgId: string;
  transport: string;
  channel: string;
  cursor: string;
  lastEvent: { createdDate: string; uuid: string };
  nextSeq: number;
  updatedAt: string;
  writer: string;
};

export async function readCheckpoint(eventsRoot: string): Promise<Checkpoint> {
  return JSON.parse(await readFile(path.join(eventsRoot, 'checkpoint.json'), 'utf8'));
}

export async function writeCheckpoint(
  eventsRoot: string,
  change: (checkpoint: Checkpoint) => Checkpoint
): Promise<Checkpoint> {
  const next = change(await readCheckpoint(eventsRoot));
  await writeFile(path.join(eventsRoot, 'checkpoint.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** A replay id of the same transport that no bus has reached. */
export function cursorAhead(cursor: string, by = 1_000_000): string {
  const [transport, value] = cursor.split(':');
  return `${transport}:${Number(value) + by}`;
}

export function daysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

let cachedUsername: string | undefined;

/** The username behind `alv-events`: what a command needs to find the store without an org connection. */
export function eventsOrgUsername(): string {
  if (cachedUsername) return cachedUsername;
  const result = spawnSync(sfBinary(), ['org', 'display', '--target-org', EVENTS_ORG_ALIAS, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    timeout: 90_000
  });
  const username = envelopeOf(result.stdout)?.result?.username;
  if (typeof username !== 'string') throw new Error('sf org display did not return a username for alv-events');
  cachedUsername = username;
  return username;
}

export type Lease = { version: number; pid: number; token: string; host: string; surface: string; startedAt: string };

export async function readLease(eventsRoot: string): Promise<Lease | undefined> {
  try {
    return JSON.parse(await readFile(path.join(eventsRoot, 'capture.lease'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
