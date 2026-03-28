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
import { resolveBundledBinary } from './bundledBinary';
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
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

export type RuntimeRequestHandler = <TResult>(
  method: string,
  params?: unknown,
  signal?: AbortSignal
) => Promise<TResult>;

export interface RuntimeClientOptions {
  clientName?: string;
  clientVersion?: string;
  createProcess?: (executable: string) => DaemonProcess;
  request?: RuntimeRequestHandler;
  requestHandler?: RuntimeRequestHandler;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
}

export class RuntimeClient extends EventEmitter {
  private daemon: DaemonProcess | undefined;
  private initializePromise: Promise<InitializeResult> | undefined;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private restartDelayMs = 250;
  private restartPromise: Promise<void> | undefined;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly createProcess: (executable: string) => DaemonProcess;
  private readonly requestHandler: RuntimeRequestHandler | undefined;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;

  constructor(options: RuntimeClientOptions = {}) {
    super();
    this.clientName = options.clientName ?? 'apex-log-viewer-vscode';
    this.clientVersion = options.clientVersion ?? '0.0.0';
    this.createProcess = options.createProcess ?? (executable => createDaemonProcess(executable));
    this.requestHandler = options.requestHandler ?? options.request;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  startRuntime(): DaemonProcess {
    if (this.daemon) {
      return this.daemon;
    }

    const executable = resolveBundledBinary(process.platform, process.arch);
    logTrace('Runtime: starting daemon', executable);
    const daemon = this.createProcess(executable);
    this.daemon = daemon;
    this.attachDaemonStderrLogger(daemon);
    daemon.onMessage(message => {
      this.handleMessage(message);
    });
    daemon.onExit((code, signal) => {
      logTrace('Runtime: daemon exited', { code, signal });
      this.failPendingRequests(new Error(`runtime exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`));
      this.daemon = undefined;
      this.initializePromise = undefined;
      this.emit(RUNTIME_EXIT_EVENT, { code, signal } satisfies RuntimeExitEvent);
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

  async orgList(params: OrgListParams = {}): Promise<OrgListItem[]> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    return this.request<OrgListItem[]>('org/list', params);
  }

  async getOrgAuth(params: OrgAuthParams = {}): Promise<OrgAuth> {
    if (!this.requestHandler) {
      await this.initialize();
    }
    return this.request<OrgAuth>('org/auth', params);
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
      this.startRuntime();
    }, delayMs);
    this.emit(RUNTIME_RESTART_EVENT, { delayMs } satisfies RuntimeRestartEvent);
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 4000);
  }

  cancel(requestId: string): void {
    logTrace('Runtime: cancel request', requestId);
    if (this.daemon) {
      this.daemon.writeMessage({
        jsonrpc: '2.0',
        method: 'cancel',
        params: { requestId }
      });
    }
    this.emit(RUNTIME_CANCEL_EVENT, { requestId } satisfies RuntimeCancelEvent);
  }

  private async request<TResult>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult> {
    if (signal?.aborted) {
      throw this.createAbortError();
    }

    if (this.requestHandler) {
      return this.requestHandler<TResult>(method, params, signal);
    }

    try {
      return await this.requestOnce<TResult>(method, params, signal);
    } catch (error) {
      if (!this.shouldRetryAfterRuntimeExit(error, signal)) {
        throw error;
      }
      logTrace('Runtime: retrying request after daemon exit', method);
      await this.restartRuntimeSession(method);
      return await this.requestOnce<TResult>(method, params, signal);
    }
  }

  private async requestOnce<TResult>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult> {
    const daemon = this.daemon ?? this.startRuntime();
    const id = `${method}:${++this.nextRequestId}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    const response = new Promise<TResult>((resolve, reject) => {
      const onAbort = () => {
        this.pendingRequests.delete(id);
        this.cancel(id);
        reject(this.createAbortError());
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as TResult),
        reject,
        cleanup: signal ? () => signal.removeEventListener('abort', onAbort) : undefined
      });
    });

    logTrace('Runtime: send request', { id, method });
    daemon.writeMessage(request);
    return response;
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
}

export const runtimeClient = new RuntimeClient();
