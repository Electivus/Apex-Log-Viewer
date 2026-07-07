import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import type {
  DebugLevelDeleteParams,
  DebugLevelGetParams,
  DebugLevelListParams,
  DebugLevelWriteParams,
  DebugLevelWriteResult,
  DoctorParams,
  DoctorResult,
  LogsDeleteParams,
  LogsDeleteResult,
  LogsListParams,
  LogsReadParams,
  LogsReadResult,
  LogsResolveParams,
  LogsResolveResult,
  LogsStatusParams,
  LogsStatusResult,
  LogsSyncParams,
  LogsSyncResult,
  LogsTriageEntry,
  LogsTriageParams,
  OrgAuth,
  OrgAuthParams,
  OrgListItem,
  OrgListParams,
  OrgResolveParams,
  OrgResolveResult,
  ResolveCachedLogPathParams,
  ResolveCachedLogPathResult,
  RuntimeDebugLevelRecord,
  RuntimeLogRow,
  ToolingQueryParams,
  ToolingQueryResult,
  ToolingRequestGetParams,
  TraceFlagApplyParams,
  TraceFlagApplyResult,
  TraceFlagRemoveParams,
  TraceFlagRemoveResult,
  TraceFlagStatusParams,
  TraceFlagTarget,
  TraceFlagTargetStatus,
  UserSearchParams,
  UserSearchResult
} from '../../../../packages/sf-plugin/src/contracts.js' with { 'resolution-mode': 'import' };
import { isTraceEnabled, logTrace } from '../../../../src/utils/logger';
import { getLoginShellEnv } from '../../../../src/salesforce/path';
import { safeSendEvent } from '../shared/telemetry';
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';

type TimerHandle = ReturnType<typeof setTimeout>;
type PendingInFlight<TResult> = {
  activeObservers: number;
  controller: AbortController;
  evict: () => void;
  promise: Promise<TResult>;
  settled: boolean;
};

export type SfPluginRunnerResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
};

export type SfPluginRunner = (
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
) => Promise<SfPluginRunnerResult>;

export interface SfPluginClientOptions {
  runner?: SfPluginRunner;
  prepareProcessEnv?: () => Promise<NodeJS.ProcessEnv | undefined>;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  workspaceRoot?: () => string | undefined;
}

const METHOD_TELEMETRY_NAMES: Record<string, string> = {
  'doctor/run': 'doctor_run',
  'org/list': 'org_list',
  'org/auth': 'org_auth',
  'org/resolve': 'org_resolve',
  'logs/list': 'logs_list',
  'logs/sync': 'logs_sync',
  'logs/status': 'logs_status',
  'logs/read': 'logs_read',
  'logs/delete': 'logs_delete',
  'logs/triage': 'logs_triage',
  'logs/resolveCachedPath': 'logs_resolve_cached_path',
  'logs/resolve': 'logs_resolve',
  'users/search': 'users_search',
  'traceFlags/status': 'trace_flags_status',
  'traceFlags/apply': 'trace_flags_apply',
  'traceFlags/remove': 'trace_flags_remove',
  'debugLevels/list': 'debug_levels_list',
  'debugLevels/get': 'debug_levels_get',
  'debugLevels/create': 'debug_levels_create',
  'debugLevels/update': 'debug_levels_update',
  'debugLevels/delete': 'debug_levels_delete',
  'tooling/query': 'tooling_query',
  'tooling/request/get': 'tooling_request_get'
};

function repoRootFromRuntimeDir(runtimeDir = __dirname): string {
  const extensionRoot = extensionRootFromRuntimeDir(runtimeDir);
  return path.basename(extensionRoot) === 'vscode-extension'
    ? path.resolve(extensionRoot, '..', '..')
    : path.resolve(runtimeDir, '..', '..', '..', '..');
}

export function extensionRootFromRuntimeDir(runtimeDir = __dirname): string {
  const currentDir = path.resolve(runtimeDir);
  if (path.basename(currentDir) === 'dist') {
    return path.resolve(currentDir, '..');
  }
  return path.resolve(currentDir, '..', '..');
}

export function resolveEmbeddedRunnerFromRuntimeDir(
  runtimeDir = __dirname,
  fileExists: (filePath: string) => boolean = existsSync
): string | undefined {
  const packaged = path.join(extensionRootFromRuntimeDir(runtimeDir), 'sf-plugin', 'electivus-runner.cjs');
  if (fileExists(packaged)) {
    return packaged;
  }
  const repoRoot = repoRootFromRuntimeDir(runtimeDir);
  const built = path.join(repoRoot, 'packages', 'sf-plugin', 'lib', 'embedded.js');
  if (fileExists(built)) {
    return built;
  }
  return undefined;
}

function resolveEmbeddedRunner(): string | undefined {
  return resolveEmbeddedRunnerFromRuntimeDir();
}

export function embeddedRunnerEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    SF_DISABLE_LOG_FILE: 'true',
    SFDX_DISABLE_LOG_FILE: 'true'
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseJsonOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('sf electivus did not produce JSON output.');
  }
  try {
    return JSON.parse(trimmed);
  } catch {}
  const cleaned = stripAnsi(trimmed);
  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');
  const start = firstObject === -1 ? firstArray : firstArray === -1 ? firstObject : Math.min(firstObject, firstArray);
  const endObject = cleaned.lastIndexOf('}');
  const endArray = cleaned.lastIndexOf(']');
  const end = Math.max(endObject, endArray);
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error(`sf electivus produced invalid JSON output: ${trimmed.slice(0, 500)}`);
}

function createAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function appendFlag(args: string[], name: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return;
  }
  args.push(name, formatFlagValue(value));
}

function formatFlagValue(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
}

function appendBool(args: string[], name: string, value: unknown): void {
  if (value === true) {
    args.push(name);
  }
}

function appendTraceTarget(args: string[], target: TraceFlagTarget): void {
  if (target.type === 'user') {
    appendFlag(args, '--user-id', target.userId);
  } else if (target.type === 'automatedProcess') {
    args.push('--automated-process');
  } else {
    args.push('--platform-integration');
  }
}

function commandArgsForMethod(method: string, params: unknown): string[] {
  const p = (params ?? {}) as Record<string, any>;
  switch (method) {
    case 'doctor/run':
      return ['doctor', ...flagList([['--target-org', p.targetOrg]])];
    case 'org/list':
      return ['orgs', 'list', ...boolList([['--force-refresh', p.forceRefresh === true]])];
    case 'org/auth':
      return ['orgs', 'auth', ...flagList([['--target-org', p.username]])];
    case 'org/resolve':
      return ['orgs', 'resolve', ...flagList([['--target-org', p.targetOrg ?? p.username]])];
    case 'logs/list': {
      const args = [
        'logs',
        'list',
        ...flagList([
          ['--target-org', p.username],
          ['--limit', p.limit]
        ])
      ];
      if (p.cursor) {
        appendFlag(args, '--before-start-time', p.cursor.beforeStartTime);
        appendFlag(args, '--before-id', p.cursor.beforeId);
      }
      return args;
    }
    case 'logs/sync':
      return [
        'logs',
        'sync',
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--workspace-root', p.workspaceRoot],
          ['--concurrency', p.concurrency]
        ]),
        ...boolList([['--force-full', p.forceFull === true]])
      ];
    case 'logs/status':
      return [
        'logs',
        'status',
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--workspace-root', p.workspaceRoot]
        ])
      ];
    case 'logs/read':
      return [
        'logs',
        'read',
        String(p.logId || ''),
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--workspace-root', p.workspaceRoot],
          ['--max-bytes', p.maxBytes]
        ])
      ];
    case 'logs/resolve':
      return [
        'logs',
        'resolve',
        String(p.logId || ''),
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--workspace-root', p.workspaceRoot]
        ])
      ];
    case 'logs/resolveCachedPath':
      return [
        'logs',
        'resolve-cached-path',
        String(p.logId || ''),
        ...flagList([
          ['--username', p.username],
          ['--workspace-root', p.workspaceRoot]
        ])
      ];
    case 'logs/triage':
      return [
        'logs',
        'triage',
        ...(Array.isArray(p.logIds) ? p.logIds.map(String) : []),
        ...flagList([
          ['--target-org', p.username],
          ['--workspace-root', p.workspaceRoot],
          ['--log-start-times', p.logStartTimes]
        ])
      ];
    case 'logs/delete':
      return [
        'logs',
        'delete',
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--workspace-root', p.workspaceRoot],
          ['--scope', p.scope],
          ['--ids', Array.isArray(p.ids) ? p.ids.join(',') : undefined],
          ['--limit', p.limit]
        ]),
        ...boolList([
          ['--dry-run', p.dryRun === true],
          ['--yes', p.confirmed === true]
        ])
      ];
    case 'users/search':
      return [
        'users',
        'search',
        ...(p.query ? [String(p.query)] : []),
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--limit', p.limit]
        ])
      ];
    case 'traceFlags/status': {
      const args = ['trace-flags', 'status', ...flagList([['--target-org', p.targetOrg]])];
      appendTraceTarget(args, p.target);
      return args;
    }
    case 'traceFlags/apply': {
      const args = [
        'trace-flags',
        'apply',
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--debug-level', p.debugLevelName],
          ['--ttl-minutes', p.ttlMinutes]
        ]),
        ...boolList([
          ['--dry-run', p.dryRun === true],
          ['--yes', p.confirmed === true]
        ])
      ];
      appendTraceTarget(args, p.target);
      return args;
    }
    case 'traceFlags/remove': {
      const args = [
        'trace-flags',
        'remove',
        ...flagList([['--target-org', p.targetOrg]]),
        ...boolList([
          ['--dry-run', p.dryRun === true],
          ['--yes', p.confirmed === true]
        ])
      ];
      appendTraceTarget(args, p.target);
      return args;
    }
    case 'debugLevels/list':
      return ['debug-levels', 'list', ...flagList([['--target-org', p.targetOrg]])];
    case 'debugLevels/get':
      return [
        'debug-levels',
        'get',
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--id', p.id],
          ['--developer-name', p.developerName]
        ])
      ];
    case 'debugLevels/create':
      return debugLevelCommandArgs('create', p);
    case 'debugLevels/update':
      return debugLevelCommandArgs('update', p);
    case 'debugLevels/delete':
      return [
        'debug-levels',
        'delete',
        ...flagList([
          ['--target-org', p.targetOrg],
          ['--id', p.id]
        ]),
        ...boolList([
          ['--dry-run', p.dryRun === true],
          ['--yes', p.confirmed === true]
        ])
      ];
    case 'tooling/query':
      return ['tooling', 'query', String(p.soql || ''), ...flagList([['--target-org', p.targetOrg]])];
    case 'tooling/request/get':
      return ['tooling', 'request', 'get', String(p.path || ''), ...flagList([['--target-org', p.targetOrg]])];
    default:
      throw new Error(`Unsupported sf electivus client method: ${method}`);
  }
}

function flagList(items: Array<[string, unknown]>): string[] {
  const args: string[] = [];
  for (const [name, value] of items) {
    appendFlag(args, name, value);
  }
  return args;
}

function boolList(items: Array<[string, boolean]>): string[] {
  const args: string[] = [];
  for (const [name, value] of items) {
    appendBool(args, name, value);
  }
  return args;
}

function debugLevelCommandArgs(command: 'create' | 'update', p: Record<string, any>): string[] {
  const record = p.record ?? p;
  return [
    'debug-levels',
    command,
    ...flagList([
      ['--target-org', p.targetOrg],
      ['--id', p.id ?? record.id],
      ['--developer-name', record.developerName],
      ['--master-label', record.masterLabel],
      ['--language', record.language],
      ['--workflow', record.workflow],
      ['--validation', record.validation],
      ['--callout', record.callout],
      ['--apex-code', record.apexCode],
      ['--apex-profiling', record.apexProfiling],
      ['--visualforce', record.visualforce],
      ['--system', record.system],
      ['--database', record.database],
      ['--wave', record.wave],
      ['--nba', record.nba],
      ['--data-access', record.dataAccess]
    ]),
    ...boolList([
      ['--dry-run', p.dryRun === true],
      ['--yes', p.confirmed === true]
    ])
  ];
}

export function runEmbeddedSfPlugin(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
): Promise<SfPluginRunnerResult> {
  const runnerPath = resolveEmbeddedRunner();
  if (!runnerPath) {
    return Promise.reject(
      new Error(
        'Unable to locate embedded sf electivus runner. Run npm run build:sf-plugin or package the extension first.'
      )
    );
  }
  const childArgs = [runnerPath, ...args, '--json'];
  const env = embeddedRunnerEnv(options.env ?? process.env);
  const cwd = options.cwd ?? process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      try {
        child.kill();
      } catch {}
      finish(() => reject(createAbortError()));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', (exitCode, signal) =>
      finish(() =>
        resolve({
          exitCode,
          signal,
          stdout,
          stderr
        })
      )
    );
  });
}

export class SfPluginClient extends EventEmitter {
  private readonly runner: SfPluginRunner;
  private readonly prepareProcessEnv: (() => Promise<NodeJS.ProcessEnv | undefined>) | undefined;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly workspaceRoot: () => string | undefined;
  private processEnvPromise: Promise<NodeJS.ProcessEnv | undefined> | undefined;
  private readonly inFlightOrgLists = new Map<string, PendingInFlight<OrgListItem[]>>();
  private readonly inFlightOrgAuth = new Map<string, PendingInFlight<OrgAuth>>();

  constructor(options: SfPluginClientOptions = {}) {
    super();
    this.runner = options.runner ?? runEmbeddedSfPlugin;
    this.prepareProcessEnv = options.prepareProcessEnv ?? getLoginShellEnv;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.workspaceRoot = options.workspaceRoot ?? (() => undefined);
  }

  async doctor(params: DoctorParams = {}, signal?: AbortSignal): Promise<DoctorResult> {
    return this.request('doctor/run', params, signal);
  }

  async orgList(params: OrgListParams = {}, signal?: AbortSignal): Promise<OrgListItem[]> {
    const key = JSON.stringify({ forceRefresh: params.forceRefresh === true });
    const pending = this.inFlightOrgLists.get(key);
    if (pending) return this.observeInFlightRequest(pending, signal);
    const tracked = this.createInFlightRequest(this.inFlightOrgLists, key, requestSignal =>
      this.request<OrgListItem[]>('org/list', params, requestSignal)
    );
    return this.observeInFlightRequest(tracked, signal);
  }

  async orgResolve(params: OrgResolveParams = {}, signal?: AbortSignal): Promise<OrgResolveResult> {
    return this.request('org/resolve', params, signal);
  }

  async getOrgAuth(params: OrgAuthParams = {}, signal?: AbortSignal): Promise<OrgAuth> {
    const key = JSON.stringify({ username: typeof params.username === 'string' ? params.username.trim() : '' });
    const pending = this.inFlightOrgAuth.get(key);
    if (pending) return this.observeInFlightRequest(pending, signal);
    const tracked = this.createInFlightRequest(this.inFlightOrgAuth, key, requestSignal =>
      this.request<OrgAuth>('org/auth', params, requestSignal)
    );
    return this.observeInFlightRequest(tracked, signal);
  }

  async logsList(params: LogsListParams = {}, signal?: AbortSignal): Promise<RuntimeLogRow[]> {
    return this.request('logs/list', params, signal);
  }

  async logsSync(params: LogsSyncParams = {}, signal?: AbortSignal): Promise<LogsSyncResult> {
    return this.request('logs/sync', this.withWorkspaceRoot(params), signal);
  }

  async logsStatus(params: LogsStatusParams = {}, signal?: AbortSignal): Promise<LogsStatusResult> {
    return this.request('logs/status', this.withWorkspaceRoot(params), signal);
  }

  async logsRead(params: LogsReadParams, signal?: AbortSignal): Promise<LogsReadResult> {
    return this.request('logs/read', this.withWorkspaceRoot(params), signal);
  }

  async logsResolve(params: LogsResolveParams, signal?: AbortSignal): Promise<LogsResolveResult> {
    return this.request('logs/resolve', this.withWorkspaceRoot(params), signal);
  }

  async logsDelete(params: LogsDeleteParams, signal?: AbortSignal): Promise<LogsDeleteResult> {
    return this.request('logs/delete', this.withWorkspaceRoot(params), signal);
  }

  async logsTriage(params: LogsTriageParams, signal?: AbortSignal): Promise<LogsTriageEntry[]> {
    return this.request('logs/triage', this.withWorkspaceRoot(params), signal);
  }

  async resolveCachedLogPath(
    params: ResolveCachedLogPathParams,
    signal?: AbortSignal
  ): Promise<ResolveCachedLogPathResult> {
    return this.request('logs/resolveCachedPath', this.withWorkspaceRoot(params), signal);
  }

  async usersSearch(params: UserSearchParams = {}, signal?: AbortSignal): Promise<UserSearchResult> {
    return this.request('users/search', params, signal);
  }

  async traceFlagStatus(params: TraceFlagStatusParams, signal?: AbortSignal): Promise<TraceFlagTargetStatus> {
    return this.request('traceFlags/status', params, signal);
  }

  async traceFlagApply(params: TraceFlagApplyParams, signal?: AbortSignal): Promise<TraceFlagApplyResult> {
    return this.request('traceFlags/apply', params, signal);
  }

  async traceFlagRemove(params: TraceFlagRemoveParams, signal?: AbortSignal): Promise<TraceFlagRemoveResult> {
    return this.request('traceFlags/remove', params, signal);
  }

  async debugLevelsList(params: DebugLevelListParams = {}, signal?: AbortSignal): Promise<RuntimeDebugLevelRecord[]> {
    return this.request('debugLevels/list', params, signal);
  }

  async debugLevelGet(params: DebugLevelGetParams, signal?: AbortSignal): Promise<RuntimeDebugLevelRecord | undefined> {
    return this.request('debugLevels/get', params, signal);
  }

  async debugLevelCreate(params: DebugLevelWriteParams, signal?: AbortSignal): Promise<DebugLevelWriteResult> {
    return this.request('debugLevels/create', { ...params, confirmed: params.confirmed ?? true }, signal);
  }

  async debugLevelUpdate(params: DebugLevelWriteParams, signal?: AbortSignal): Promise<DebugLevelWriteResult> {
    return this.request('debugLevels/update', { ...params, confirmed: params.confirmed ?? true }, signal);
  }

  async debugLevelDelete(params: DebugLevelDeleteParams, signal?: AbortSignal): Promise<DebugLevelWriteResult> {
    return this.request('debugLevels/delete', { ...params, confirmed: params.confirmed ?? true }, signal);
  }

  async toolingQuery(params: ToolingQueryParams, signal?: AbortSignal): Promise<ToolingQueryResult> {
    return this.request('tooling/query', params, signal);
  }

  async toolingRequestGet(params: ToolingRequestGetParams, signal?: AbortSignal): Promise<unknown> {
    return this.request('tooling/request/get', params, signal);
  }

  private withWorkspaceRoot<T extends { workspaceRoot?: string }>(params: T): T {
    return params.workspaceRoot ? params : { ...params, workspaceRoot: this.workspaceRoot() ?? os.tmpdir() };
  }

  private createInFlightRequest<TResult>(
    store: Map<string, PendingInFlight<TResult>>,
    key: string,
    start: (signal: AbortSignal) => Promise<TResult>
  ): PendingInFlight<TResult> {
    const controller = new AbortController();
    const entry: PendingInFlight<TResult> = {
      activeObservers: 0,
      controller,
      evict: () => {
        if (store.get(key) === entry) store.delete(key);
      },
      promise: Promise.resolve(undefined as TResult),
      settled: false
    };
    entry.promise = start(controller.signal).finally(() => {
      entry.settled = true;
      entry.evict();
    });
    store.set(key, entry);
    return entry;
  }

  private observeInFlightRequest<TResult>(entry: PendingInFlight<TResult>, signal?: AbortSignal): Promise<TResult> {
    if (signal?.aborted) return Promise.reject(createAbortError());
    entry.activeObservers += 1;
    const release = () => {
      entry.activeObservers = Math.max(0, entry.activeObservers - 1);
      if (!entry.settled && entry.activeObservers === 0) {
        entry.evict();
        entry.controller.abort();
      }
    };
    if (!signal) return entry.promise.finally(release);
    return new Promise<TResult>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        release();
        callback();
      };
      const onAbort = () => finish(() => reject(createAbortError()));
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error))
      );
    });
  }

  private async request<TResult>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult> {
    const t0 = Date.now();
    if (signal?.aborted) {
      this.sendTelemetry(method, 'cancelled', t0);
      throw createAbortError();
    }
    try {
      const args = commandArgsForMethod(method, params);
      const env = await this.resolveProcessEnv();
      if (isTraceEnabled()) {
        logTrace('sf-plugin: run', args.join(' '));
      }
      const result = await this.runner(args, { cwd: this.workspaceRoot(), env, signal });
      if (result.exitCode !== 0) {
        const parsed = result.stdout.trim() ? tryParseError(result.stdout) : undefined;
        throw new Error(parsed || result.stderr.trim() || `sf electivus exited with code ${result.exitCode}`);
      }
      const parsed = parseJsonOutput(result.stdout) as TResult;
      this.sendTelemetry(method, 'ok', t0);
      return parsed;
    } catch (error) {
      this.sendTelemetry(method, signal?.aborted ? 'cancelled' : 'error', t0, error);
      throw error;
    }
  }

  private async resolveProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.prepareProcessEnv) return undefined;
    if (!this.processEnvPromise) {
      this.processEnvPromise = this.prepareProcessEnv();
    }
    const shellEnv = await this.processEnvPromise;
    if (!shellEnv) return undefined;
    return { ...process.env, ...shellEnv };
  }

  private sendTelemetry(
    method: string,
    outcome: 'ok' | 'error' | 'cancelled',
    startedAt: number,
    error?: unknown
  ): void {
    try {
      const durationMs = Date.now() - startedAt;
      const methodName = METHOD_TELEMETRY_NAMES[method] ?? method.replace(/[^a-z0-9_]+/gi, '_');
      const properties: Record<string, string> = { method: methodName, outcome };
      if (error) properties.code = getTelemetryErrorCode(error);
      safeSendEvent('sfPlugin.request', properties, { durationMs });
    } catch {}
  }

  // Kept for existing tests/consumers that call schedule-like behavior.
  scheduleRestart(): void {
    this.schedule(() => undefined, 0);
  }
}

function tryParseError(raw: string): string | undefined {
  try {
    const parsed = parseJsonOutput(raw) as { message?: unknown; error?: { message?: unknown } };
    return typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error?.message === 'string'
        ? parsed.error.message
        : undefined;
  } catch {
    return undefined;
  }
}

export const runtimeClient = new SfPluginClient();
export const sfPluginClient = runtimeClient;
export { SfPluginClient as RuntimeClient };
