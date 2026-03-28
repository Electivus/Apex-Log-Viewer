import { EventEmitter } from 'node:events';
import type {
  DaemonProcess,
  InitializeResult
} from '../../../../packages/app-server-client-ts/src';
import { createDaemonProcess } from '../../../../packages/app-server-client-ts/src';
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

export interface RuntimeClientOptions {
  clientName?: string;
  clientVersion?: string;
  createProcess?: (executable: string) => DaemonProcess;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
}

export class RuntimeClient extends EventEmitter {
  private daemon: DaemonProcess | undefined;
  private restartDelayMs = 250;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly createProcess: (executable: string) => DaemonProcess;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;

  constructor(options: RuntimeClientOptions = {}) {
    super();
    this.clientName = options.clientName ?? 'apex-log-viewer-vscode';
    this.clientVersion = options.clientVersion ?? '0.0.0';
    this.createProcess = options.createProcess ?? (executable => createDaemonProcess(executable));
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  startRuntime(): DaemonProcess {
    const executable = resolveBundledBinary(process.platform, process.arch);
    const daemon = this.createProcess(executable);
    this.daemon = daemon;
    daemon.onExit((code, signal) => {
      this.emit(RUNTIME_EXIT_EVENT, { code, signal } satisfies RuntimeExitEvent);
    });
    return daemon;
  }

  async initialize(): Promise<InitializeResult> {
    const daemon = this.daemon ?? this.startRuntime();
    daemon.writeMessage({
      jsonrpc: '2.0',
      id: 'initialize',
      method: 'initialize',
      params: {
        client_name: this.clientName,
        client_version: this.clientVersion
      }
    });

    return {
      runtime_version: this.clientVersion,
      protocol_version: '1',
      platform: process.platform,
      arch: process.arch,
      capabilities: {
        orgs: true,
        logs: true,
        search: true,
        tail: true,
        debug_flags: true,
        doctor: true
      },
      state_dir: '.alv/state',
      cache_dir: '.alv/cache'
    };
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
}
