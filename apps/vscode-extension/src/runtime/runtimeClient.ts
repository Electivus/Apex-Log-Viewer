import { EventEmitter } from 'node:events';
import type {
  DaemonProcess,
  OrgAuth,
  OrgAuthParams,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
  InitializeResult
} from '../../../../packages/app-server-client-ts/src/index';
import { createDaemonProcess } from '../../../../packages/app-server-client-ts/src/index';
import type { JsonRpcRequest, OrgListItem, OrgListParams } from '../../../../packages/app-server-client-ts/src/index';
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
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type RuntimeRequestHandler = <TResult>(method: string, params?: unknown) => Promise<TResult>;

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
    const daemon = this.createProcess(executable);
    this.daemon = daemon;
    daemon.onMessage(message => {
      this.handleMessage(message);
    });
    daemon.onExit((code, signal) => {
      this.failPendingRequests(new Error(`runtime exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`));
      this.daemon = undefined;
      this.initializePromise = undefined;
      this.emit(RUNTIME_EXIT_EVENT, { code, signal } satisfies RuntimeExitEvent);
    });
    return daemon;
  }

  async initialize(): Promise<InitializeResult> {
    if (!this.initializePromise) {
      this.initializePromise = this.request<InitializeResult>('initialize', {
        client_name: this.clientName,
        client_version: this.clientVersion
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

  scheduleRestart(): void {
    const delayMs = this.restartDelayMs;
    this.schedule(() => {
      this.startRuntime();
    }, delayMs);
    this.emit(RUNTIME_RESTART_EVENT, { delayMs } satisfies RuntimeRestartEvent);
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 4000);
  }

  cancel(requestId: string): void {
    if (this.daemon) {
      this.daemon.writeMessage({
        jsonrpc: '2.0',
        method: 'cancel',
        params: { requestId }
      });
    }
    this.emit(RUNTIME_CANCEL_EVENT, { requestId } satisfies RuntimeCancelEvent);
  }

  private async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (this.requestHandler) {
      return this.requestHandler<TResult>(method, params);
    }

    const daemon = this.daemon ?? this.startRuntime();
    const id = `${method}:${++this.nextRequestId}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    const response = new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as TResult),
        reject
      });
    });

    daemon.writeMessage(request);
    return response;
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
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private failPendingRequests(error: Error): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }
}

export const runtimeClient = new RuntimeClient();
