import { settle } from './webviewSessionTestSupport';
import type {
  CustomLogApexLogLink,
  CustomLogColumn,
  CustomLogEntry,
  CustomLogPayloadField,
  CustomLogRow,
  CustomLogSourceView,
  CustomLogStoreView
} from '../shared/customLogsTypes';
import type {
  CustomLogCaptureCallOptions,
  CustomLogCaptureResultView,
  CustomLogCaptureUpdateView
} from '../runtime/runtimeClient';

type Message = { type: string } & Record<string, unknown>;

/** A WebviewView / WebviewPanel host: records what is posted and lets a test speak as the webview. */
export class FakeHost {
  visible = true;
  readonly posted: Message[] = [];
  readonly webview = {
    options: undefined as unknown,
    html: '',
    postMessage: async (message: Message): Promise<boolean> => {
      this.posted.push(message);
      return true;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void | Promise<void>) => {
      this.listeners.add(listener);
      return { dispose: () => void this.listeners.delete(listener) };
    }
  };
  private readonly listeners = new Set<(message: unknown) => void | Promise<void>>();
  private readonly disposeListeners = new Set<() => void>();

  recoverAfterReadyTimeout(): void {}

  onDidDispose(listener: () => void) {
    this.disposeListeners.add(listener);
    return { dispose: () => void this.disposeListeners.delete(listener) };
  }

  onDidChangeVisibility() {
    return { dispose: () => undefined };
  }

  /** The webview speaks. */
  async emit(message: unknown): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(message);
    }
    await settle();
  }

  dispose(): void {
    for (const listener of [...this.disposeListeners]) {
      listener();
    }
  }

  ofType(type: string): Message[] {
    return this.posted.filter(message => message.type === type);
  }

  last(type: string): Message | undefined {
    return this.ofType(type).at(-1);
  }

  clear(): void {
    this.posted.length = 0;
  }
}

export function createMemento(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }
  };
}

export function formatLocalized(message: string, ...args: Array<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/g, (match, index) =>
    args[Number(index)] === undefined ? match : String(args[Number(index)])
  );
}

export const vscodeStub = {
  env: { language: 'en', clipboard: { writeText: async () => undefined } },
  Uri: { joinPath: (base: unknown, ...parts: string[]) => ({ base, parts }) },
  Disposable: {
    from: (...items: Array<{ dispose(): void }>) => ({ dispose: () => items.forEach(item => item.dispose()) })
  },
  commands: {
    executed: [] as string[],
    executeCommand: async (command: string) => {
      vscodeStub.commands.executed.push(command);
    }
  },
  window: {
    infoMessages: [] as string[],
    showInformationMessage: async (message: string) => {
      vscodeStub.window.infoMessages.push(message);
      return undefined;
    }
  }
};

export function resetVscodeStub(): void {
  vscodeStub.commands.executed.length = 0;
  vscodeStub.window.infoMessages.length = 0;
}

// ---------------------------------------------------------------------------------------------
// Fixtures: DTOs as core hands them to the client.

export const NEBULA: CustomLogSourceView = {
  id: 'nebula',
  label: 'Nebula Logger',
  origin: 'builtin',
  shape: 'transactions',
  hiddenFields: [],
  capabilities: { levelFilter: true, userFilter: true, apexLogLink: true },
  payload: {},
  state: 'ready'
};

export const APP_LOG: CustomLogSourceView = {
  id: 'app-log',
  label: 'App Log',
  origin: 'config',
  shape: 'entries',
  hiddenFields: [],
  capabilities: { levelFilter: false, userFilter: false, apexLogLink: false },
  payload: { entry: { field: 'Payload__c', columns: ['orderId'] } },
  state: 'ready'
};

export const EVENTS: CustomLogSourceView = {
  id: 'app-events',
  label: 'App events',
  origin: 'config',
  shape: 'events',
  hiddenFields: [],
  capabilities: { levelFilter: true, userFilter: true, apexLogLink: false },
  payload: {},
  state: 'ready'
};

export const NOT_INSTALLED: CustomLogSourceView = {
  id: 'nebula-managed',
  label: 'Nebula Logger (managed)',
  origin: 'builtin',
  shape: 'transactions',
  namespace: 'Nebula',
  hiddenFields: [],
  capabilities: { levelFilter: false, userFilter: false, apexLogLink: false },
  payload: {},
  state: 'notInstalled'
};

export const LOG_IDS = {
  first: 'a02000000000001AAA',
  second: 'a02000000000002AAA',
  third: 'a02000000000003AAA'
} as const;

/** An event row id as core builds it: fixed width, so plain string order is list order. */
export function eventId(n: number): string {
  return `e-mgv1x3a2k-${n.toString(36).padStart(10, '0')}-${'a'.repeat(32)}`;
}

export const NOT_CAPTURED: CustomLogStoreView = {
  state: 'notCaptured',
  eventsRoot: '/project/apexlogs/orgs/dev/events/App_Log__e',
  retentionDays: 30
};

export const CAPTURED: CustomLogStoreView = {
  state: 'captured',
  eventsRoot: '/project/apexlogs/orgs/dev/events/App_Log__e',
  oldest: '2026-10-02T09:14:03.120Z',
  newest: '2026-10-30T17:58:41.007Z',
  lastCaptureAt: '2026-10-30T17:58:52.311Z',
  sizeBytes: 19_293_184,
  retentionDays: 30,
  gaps: []
};

export function row(id: string, title = id, extra: Partial<CustomLogRow> = {}): CustomLogRow {
  return { id, time: '2026-10-30T00:48:10.000Z', title, extra: {}, ...extra };
}

export function field(
  path: string,
  rows = 1,
  types: CustomLogPayloadField['types'] = ['string']
): CustomLogPayloadField {
  return { path, types, rows };
}

export function entry(id: string, sequence: number, message = `entry ${sequence}`): CustomLogEntry {
  return {
    id,
    sequence,
    time: '2026-10-30T00:48:10.000Z',
    message,
    previewClipped: false,
    system: false,
    presentDetails: [],
    extra: {}
  };
}

export const NO_COLUMNS: CustomLogColumn[] = [];
export const LINKED = { state: 'linked', logId: '07L000000000001AAA' } as const satisfies CustomLogApexLogLink;

type CallLog<T> = T[];

/** One `customLog.capture` call the provider made: the test plays core, which reports updates until it ends. */
export class FakeCapture {
  readonly promise: Promise<CustomLogCaptureResultView>;
  private settle!: { resolve(result: CustomLogCaptureResultView): void; reject(error: unknown): void };

  constructor(
    readonly params: Record<string, unknown>,
    private readonly options: CustomLogCaptureCallOptions
  ) {
    this.promise = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // Core resolves an aborted capture with outcome `aborted`; it never rejects with ABORTED.
    options.signal?.addEventListener('abort', () => this.settle.resolve({ outcome: 'aborted', store: CAPTURED }), {
      once: true
    });
  }

  get aborted(): boolean {
    return this.options.signal?.aborted === true;
  }

  report(update: Partial<CustomLogCaptureUpdateView> = {}): void {
    this.options.onUpdate?.({
      capture: { state: 'live', basis: 'quiet' },
      store: CAPTURED,
      rows: [],
      payloadFields: [],
      ...update
    });
  }

  end(outcome: CustomLogCaptureResultView['outcome'], store: CustomLogStoreView = CAPTURED): void {
    this.settle.resolve({ outcome, store });
  }

  fail(error: unknown): void {
    this.settle.reject(error);
  }
}

/** A scripted `runtimeClient`: every method records its params and answers from a replaceable handler. */
export function createFakeRuntimeClient() {
  const calls = {
    orgList: [] as CallLog<unknown>,
    customLogSources: [] as CallLog<Record<string, unknown>>,
    customLogList: [] as CallLog<Record<string, unknown>>,
    customLogGet: [] as CallLog<Record<string, unknown>>,
    customLogEntry: [] as CallLog<Record<string, unknown>>,
    customLogCapture: [] as CallLog<FakeCapture>,
    /** Which calls started, in order, so a test can tell "capture after the page" from "page after capture". */
    order: [] as string[]
  };
  const handlers = {
    orgList: async (): Promise<Array<{ username: string; alias?: string; isDefaultUsername?: boolean }>> => [
      { username: 'dev@example.com', alias: 'dev', isDefaultUsername: true },
      { username: 'qa@example.com', alias: 'qa' }
    ],
    customLogSources: async (_params: Record<string, unknown>): Promise<unknown> => ({
      defaultSourceId: undefined,
      sources: [NEBULA, APP_LOG, NOT_INSTALLED],
      issues: []
    }),
    customLogList: async (_params: Record<string, unknown>): Promise<unknown> => ({
      source: { id: 'nebula', label: 'Nebula Logger', shape: 'transactions' },
      columns: NO_COLUMNS,
      rows: [row(LOG_IDS.first), row(LOG_IDS.second)],
      payloadFields: [],
      nextCursor: null
    }),
    customLogGet: async (_params: Record<string, unknown>): Promise<unknown> => ({}),
    customLogEntry: async (_params: Record<string, unknown>): Promise<unknown> => ({})
  };
  const client = {
    orgList: (...args: unknown[]) => {
      calls.orgList.push(args[0]);
      return handlers.orgList();
    },
    customLogSources: (params: Record<string, unknown>) => {
      calls.customLogSources.push(params);
      return handlers.customLogSources(params);
    },
    customLogList: (params: Record<string, unknown>) => {
      calls.customLogList.push(params);
      calls.order.push('list');
      return handlers.customLogList(params);
    },
    customLogCapture: (params: Record<string, unknown>, options: CustomLogCaptureCallOptions) => {
      const capture = new FakeCapture(params, options);
      calls.customLogCapture.push(capture);
      calls.order.push('capture');
      return capture.promise;
    },
    customLogGet: (params: Record<string, unknown>) => {
      calls.customLogGet.push(params);
      return handlers.customLogGet(params);
    },
    customLogEntry: (params: Record<string, unknown>) => {
      calls.customLogEntry.push(params);
      return handlers.customLogEntry(params);
    }
  };
  return { client, calls, handlers };
}

export interface RecordedEvent {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
}
