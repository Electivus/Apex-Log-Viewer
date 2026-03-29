import { EventEmitter } from 'node:events';
import type {
  DaemonProcess,
  OrgAuth,
  OrgAuthParams,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
  InitializeResult,
  LogsListParams,
  LogsTriageEntry,
  LogsTriageParams,
  RuntimeLogRow,
  SearchQueryParams,
  SearchQueryResult
} from '../../../../packages/app-server-client-ts/src/index';
import { createDaemonProcess } from '../../../../packages/app-server-client-ts/src/index';
import type { JsonRpcRequest, OrgListItem, OrgListParams } from '../../../../packages/app-server-client-ts/src/index';
import { logTrace } from '../../../../src/utils/logger';
import { getLoginShellEnv } from '../../../../src/salesforce/path';
import { safeSendEvent } from '../shared/telemetry';
import { resolveBundledBinary } from './bundledBinary';
import { resolveRuntimeExecutable } from './runtimeExecutable';
import {
  RUNTIME_CANCEL_EVENT,
  RUNTIME_EXIT_EVENT,
  RUNTIME_RESTART_EVENT,
  type RuntimeCancelEvent,
  type RuntimeExitEvent,
  type RuntimeRestartEvent
} from './runtimeEvents';

type TimerHandle = ReturnType<typeof setTimeout>;
const RUNTIME_EXIT_MESSAGE_PREFIX = 'runtime exited (';
const RUNTIME_TELEMETRY_METHODS = new Set(['initialize', 'org/list', 'org/auth', 'logs/list', 'search/query', 'logs/triage']);

function getConfiguredRuntimePath(): string {
  const { getConfig } = require('../../../../src/utils/config') as typeof import('../../../../src/utils/config');
  return getConfig('electivus.apexLogs.runtimePath', '');
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};
type InFlightRequest<TResult> = {
  activeObservers: number;
  controller: AbortController;
  evict: () => void;
  promise: Promise<TResult>;
  settled: boolean;
};

export type RuntimeRequestHandler = <TResult>(
  method: string,
  params?: unknown,
  signal?: AbortSignal
) => Promise<TResult>;

export interface RuntimeClientOptions {
  clientName?: string;
  clientVersion?: string;
  createProcess?: (executable: string, env?: NodeJS.ProcessEnv) => DaemonProcess;
  prepareProcessEnv?: () => Promise<NodeJS.ProcessEnv | undefined>;
  request?: RuntimeRequestHandler;
  requestHandler?: RuntimeRequestHandler;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
}

export class RuntimeClient extends EventEmitter {
  private daemon: DaemonProcess | undefined;
  private initializePromise: Promise<InitializeResult> | undefined;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly inFlightOrgLists = new Map<string, InFlightRequest<OrgListItem[]>>();
  private readonly inFlightOrgAuth = new Map<string, InFlightRequest<OrgAuth>>();
  private restartDelayMs = 250;
  private restartPromise: Promise<void> | undefined;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly createProcess: (executable: string, env?: NodeJS.ProcessEnv) => DaemonProcess;
  private readonly prepareProcessEnv: (() => Promise<NodeJS.ProcessEnv | undefined>) | undefined;
  private readonly requestHandler: RuntimeRequestHandler | undefined;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private processEnvPromise: Promise<NodeJS.ProcessEnv | undefined> | undefined;

  constructor(options: RuntimeClientOptions = {}) {
    super();
    this.clientName = options.clientName ?? 'apex-log-viewer-vscode';
    this.clientVersion = options.clientVersion ?? '0.0.0';
    this.createProcess =
      options.createProcess ??
      ((executable, env) => createDaemonProcess(executable, undefined, env ? { env } : undefined));
    this.prepareProcessEnv = options.prepareProcessEnv ?? getLoginShellEnv;
    this.requestHandler = options.requestHandler ?? options.request;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  async startRuntime(): Promise<DaemonProcess> {
    if (this.daemon) {
      return this.daemon;
    }

    const bundledPath = resolveBundledBinary(process.platform, process.arch);
    const executableResolution = resolveRuntimeExecutable({
      configuredPath: getConfiguredRuntimePath(),
      bundledPath
    });
    const env = await this.resolveProcessEnv();
    if (executableResolution.showManualOverrideWarning) {
      logTrace('Runtime: using manually configured runtime executable', executableResolution.executable);
    }
    logTrace('Runtime: starting daemon', executableResolution.executable);
    const daemon = this.createProcess(executableResolution.executable, env);
    this.daemon = daemon;
    this.attachDaemonStderrLogger(daemon);
    daemon.onMessage(message => {
      this.handleMessage(message);
    });
    daemon.onError(error => {
      this.handleDaemonFailure(daemon, this.normalizeDaemonError(error), { code: null, signal: null });
    });
    daemon.onExit((code, signal) => {
      this.handleDaemonFailure(
        daemon,
        new Error(`runtime exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`),
        { code, signal }
      );
    });
    return daemon;
  }

  async initialize(): Promise<InitializeResult> {
    if (!this.initializePromise) {
      const pendingInitialize = this.request<InitializeResult>('initialize', {
        client_name: this.clientName,
        client_version: this.clientVersion
      });
      this.initializePromise = pendingInitialize.catch(error => {
        if (this.initializePromise === pendingInitialize) {
          this.initializePromise = undefined;
        }
        throw error;
      });
    }
    return this.initializePromise;
  }

  async orgList(params: OrgListParams = {}, signal?: AbortSignal): Promise<OrgListItem[]> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    if (signal?.aborted) {
      throw this.createAbortError();
    }
    const key = JSON.stringify({ forceRefresh: params.forceRefresh === true });
    const pending = this.inFlightOrgLists.get(key);
    if (pending) {
      return this.observeInFlightRequest(pending, signal);
    }
    const tracked = this.createInFlightRequest(this.inFlightOrgLists, key, requestSignal =>
      this.request<OrgListItem[]>('org/list', params, requestSignal)
    );
    return this.observeInFlightRequest(tracked, signal);
  }

  async getOrgAuth(params: OrgAuthParams = {}, signal?: AbortSignal): Promise<OrgAuth> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    if (signal?.aborted) {
      throw this.createAbortError();
    }
    const key = JSON.stringify({ username: typeof params.username === 'string' ? params.username.trim() : '' });
    const pending = this.inFlightOrgAuth.get(key);
    if (pending) {
      return this.observeInFlightRequest(pending, signal);
    }
    const tracked = this.createInFlightRequest(this.inFlightOrgAuth, key, requestSignal =>
      this.request<OrgAuth>('org/auth', params, requestSignal)
    );
    return this.observeInFlightRequest(tracked, signal);
  }

  async logsList(params: LogsListParams = {}, signal?: AbortSignal): Promise<RuntimeLogRow[]> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    return this.request<RuntimeLogRow[]>('logs/list', params, signal);
  }

  async searchQuery(params: SearchQueryParams, signal?: AbortSignal): Promise<SearchQueryResult> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    return this.request<SearchQueryResult>('search/query', params, signal);
  }

  async logsTriage(params: LogsTriageParams, signal?: AbortSignal): Promise<LogsTriageEntry[]> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    return this.request<LogsTriageEntry[]>('logs/triage', params, signal);
  }

  scheduleRestart(): void {
    const delayMs = this.restartDelayMs;
    this.schedule(() => {
      void this.startRuntime();
    }, delayMs);
    this.emit(RUNTIME_RESTART_EVENT, { delayMs } satisfies RuntimeRestartEvent);
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 4000);
  }

  cancel(requestId: string): void {
    logTrace('Runtime: cancel request', requestId);
    const daemon = this.daemon;
    if (daemon) {
      try {
        daemon.writeMessage({
          jsonrpc: '2.0',
          method: 'cancel',
          params: { requestId }
        });
      } catch (error) {
        const writeError = error instanceof Error ? error : new Error(String(error));
        if (this.isRetryableWriteError(writeError)) {
          const normalizedError = this.normalizeDaemonError(writeError);
          this.handleDaemonFailure(daemon, normalizedError, { code: null, signal: null });
        } else {
          logTrace('Runtime: ignoring cancel write failure', { requestId, message: writeError.message });
        }
      }
    }
    this.emit(RUNTIME_CANCEL_EVENT, { requestId } satisfies RuntimeCancelEvent);
  }

  private createInFlightRequest<TResult>(
    store: Map<string, InFlightRequest<TResult>>,
    key: string,
    start: (signal: AbortSignal) => Promise<TResult>
  ): InFlightRequest<TResult> {
    const controller = new AbortController();
    const entry: InFlightRequest<TResult> = {
      activeObservers: 0,
      controller,
      evict: () => {
        if (store.get(key) === entry) {
          store.delete(key);
        }
      },
      promise: Promise.resolve(undefined as TResult),
      settled: false
    };
    const request = start(controller.signal);
    entry.promise = request.finally(() => {
      entry.settled = true;
      entry.evict();
    });
    store.set(key, entry);
    return entry;
  }

  private observeInFlightRequest<TResult>(entry: InFlightRequest<TResult>, signal?: AbortSignal): Promise<TResult> {
    if (signal?.aborted) {
      return Promise.reject(this.createAbortError());
    }

    entry.activeObservers += 1;
    const release = () => {
      entry.activeObservers = Math.max(0, entry.activeObservers - 1);
      if (!entry.settled && entry.activeObservers === 0) {
        entry.evict();
        entry.controller.abort();
      }
    };

    if (!signal) {
      return entry.promise.finally(release);
    }

    return new Promise<TResult>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) {
          return;
        }
        finished = true;
        signal.removeEventListener('abort', onAbort);
        release();
        callback();
      };
      const onAbort = () => {
        finish(() => reject(this.createAbortError()));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error))
      );
    });
  }

  private async request<TResult>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult> {
    const t0 = Date.now();
    let attempts = 1;

    try {
      if (signal?.aborted) {
        throw this.createAbortError();
      }
      if (this.requestHandler) {
        const result = await this.requestHandler<TResult>(method, params, signal);
        this.sendRuntimeRequestTelemetry(method, 'ok', t0, attempts);
        return result;
      }

      try {
        const result = await this.requestOnce<TResult>(method, params, signal);
        this.sendRuntimeRequestTelemetry(method, 'ok', t0, attempts);
        return result;
      } catch (error) {
        if (!this.shouldRetryAfterRuntimeExit(error, signal)) {
          throw error;
        }
        logTrace('Runtime: retrying request after daemon exit', method);
        attempts += 1;
        await this.restartRuntimeSession(method);
        const result = await this.requestOnce<TResult>(method, params, signal);
        this.sendRuntimeRequestTelemetry(method, 'ok', t0, attempts);
        return result;
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        this.sendRuntimeRequestTelemetry(method, 'cancelled', t0, attempts);
      } else {
        this.sendRuntimeRequestTelemetry(method, 'error', t0, attempts);
      }
      throw error;
    }
  }

  private async requestOnce<TResult>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult> {
    const daemon = this.daemon ?? (await this.startRuntime());
    const id = `${method}:${++this.nextRequestId}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    let cleanup: (() => void) | undefined;
    const response = new Promise<TResult>((resolve, reject) => {
      const onAbort = () => {
        this.pendingRequests.delete(id);
        this.cancel(id);
        reject(this.createAbortError());
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      cleanup = signal ? () => signal.removeEventListener('abort', onAbort) : undefined;
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as TResult),
        reject,
        cleanup
      });
    });

    logTrace('Runtime: send request', { id, method });
    try {
      daemon.writeMessage(request);
    } catch (error) {
      const writeError = error instanceof Error ? error : new Error(String(error));
      this.pendingRequests.delete(id);
      cleanup?.();
      if (this.isRetryableWriteError(writeError)) {
        const normalizedError = this.normalizeDaemonError(writeError);
        this.handleDaemonFailure(daemon, normalizedError, { code: null, signal: null });
        throw normalizedError;
      }
      throw writeError;
    }
    return response;
  }

  private isRetryableWriteError(error: Error): boolean {
    const errnoError = error as NodeJS.ErrnoException;
    const message = error.message.toLowerCase();
    return (
      errnoError.code === 'EPIPE' ||
      errnoError.code === 'ERR_STREAM_DESTROYED' ||
      message.includes('epipe') ||
      message.includes('write after end') ||
      message.includes('stream was destroyed') ||
      message.includes('stream is destroyed')
    );
  }

  private shouldRetryAfterRuntimeExit(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
      return false;
    }
    return error instanceof Error && error.message.startsWith(RUNTIME_EXIT_MESSAGE_PREFIX);
  }

  private async restartRuntimeSession(method: string): Promise<void> {
    logTrace('Runtime: restarting session', method);
    if (method === 'initialize') {
      this.daemon = undefined;
      this.initializePromise = undefined;
      return;
    }
    if (!this.restartPromise) {
      const restart = this.initialize().then(() => undefined);
      const trackedRestart = restart.finally(() => {
        if (this.restartPromise === trackedRestart) {
          this.restartPromise = undefined;
        }
      });
      this.restartPromise = trackedRestart;
    }
    await this.restartPromise;
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    const response = message as Partial<JsonRpcSuccessResponse<unknown> & JsonRpcErrorResponse>;
    if (typeof response.id !== 'string') {
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logTrace('Runtime: received response without pending request', response.id);
      return;
    }

    this.pendingRequests.delete(response.id);
    pending.cleanup?.();

    if (response.error) {
      logTrace('Runtime: received error response', { id: response.id, message: response.error.message });
      pending.reject(new Error(response.error.message));
      return;
    }

    logTrace('Runtime: received success response', response.id);
    pending.resolve(response.result);
  }

  private failPendingRequests(error: Error): void {
    logTrace('Runtime: failing pending requests', { count: this.pendingRequests.size, message: error.message });
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const request of pending) {
      request.cleanup?.();
      request.reject(error);
    }
  }

  private handleDaemonFailure(
    daemon: DaemonProcess,
    error: Error,
    { code, signal }: { code: number | null; signal: NodeJS.Signals | null }
  ): void {
    if (this.daemon !== daemon) {
      return;
    }
    logTrace('Runtime: daemon failure', { code, signal, message: error.message });
    this.failPendingRequests(error);
    this.daemon = undefined;
    this.initializePromise = undefined;
    this.emit(RUNTIME_EXIT_EVENT, { code, signal } satisfies RuntimeExitEvent);
  }

  private normalizeDaemonError(error: Error): Error {
    if (error.message.startsWith(RUNTIME_EXIT_MESSAGE_PREFIX)) {
      return error;
    }
    return new Error(`runtime exited (process error: ${error.message})`);
  }

  private attachDaemonStderrLogger(daemon: DaemonProcess): void {
    const stderr = (daemon.child as { stderr?: NodeJS.ReadableStream } | undefined)?.stderr;
    if (!stderr || typeof stderr.on !== 'function') {
      return;
    }
    stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          logTrace('Runtime stderr:', trimmed);
        }
      }
    });
  }

  private createAbortError(): Error {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    return error;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.message === 'Request aborted');
  }

  private sendRuntimeRequestTelemetry(
    method: string,
    outcome: 'ok' | 'error' | 'cancelled',
    startedAt: number,
    attempts: number
  ): void {
    try {
      safeSendEvent(
        'daemon.request',
        {
          method: RUNTIME_TELEMETRY_METHODS.has(method) ? method : 'other',
          outcome
        },
        {
          durationMs: Date.now() - startedAt,
          attempts
        }
      );
    } catch {}
  }

  private async resolveProcessEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.prepareProcessEnv) {
      return undefined;
    }
    if (!this.processEnvPromise) {
      this.processEnvPromise = this.prepareProcessEnv().catch(error => {
        logTrace('Runtime: daemon env preparation failed', error instanceof Error ? error.message : String(error));
        return undefined;
      });
    }
    return this.processEnvPromise;
  }
}

export const runtimeClient = new RuntimeClient();
