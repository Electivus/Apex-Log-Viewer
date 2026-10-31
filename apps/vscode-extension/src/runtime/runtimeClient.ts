import os from 'node:os';

import {
  createApexLogViewerCore,
  type ApexLogLifecycleEvent,
  type ApexLogLocalFile,
  type ApexLogViewerCore,
  type AvailableLocalPathsResult,
  type PurgeApexLogsResult,
  type ReadApexLogResult
} from '@alv/core';
import type * as core from '@alv/core/contracts';
import type {
  CustomLogEntryParams,
  CustomLogEntryResult,
  CustomLogGetParams,
  CustomLogListParams,
  CustomLogSourcesParams,
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
  TraceFlagTargetStatus,
  UserSearchParams,
  UserSearchResult
} from '@alv/core/contracts';
import type * as ui from '@alv/protocol/customLogsTypes';
import type { ApexLogRow } from '@alv/protocol/types';

import { safeSendEvent } from '../shared/telemetry';
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';

type PendingInFlight<TResult> = {
  activeObservers: number;
  controller: AbortController;
  evict: () => void;
  promise: Promise<TResult>;
  settled: boolean;
};

export type CoreClientOptions = {
  core?: ApexLogViewerCore;
  workspaceRoot?: () => string | undefined;
};

const TELEMETRY_METHOD_NAMES: Record<string, string> = {
  doctor: 'doctor',
  'org.list': 'org_list',
  'org.resolve': 'org_resolve',
  'org.getAuth': 'org_get_auth',
  'log.list': 'log_list',
  'log.sync': 'log_sync',
  'log.status': 'log_status',
  'log.read': 'log_read',
  'log.resolve': 'log_resolve',
  'log.triage': 'log_triage',
  'log.delete': 'log_delete',
  'log.lifecycle.requireLocalPath': 'log_lifecycle_require_local_path',
  'log.lifecycle.availableLocalPaths': 'log_lifecycle_available_local_paths',
  'log.lifecycle.read': 'log_lifecycle_read',
  'log.lifecycle.sync': 'log_lifecycle_sync',
  'log.lifecycle.status': 'log_lifecycle_status',
  'log.lifecycle.triage': 'log_lifecycle_triage',
  'log.lifecycle.purge': 'log_lifecycle_purge',
  'user.search': 'user_search',
  'traceFlag.status': 'trace_flag_status',
  'traceFlag.apply': 'trace_flag_apply',
  'traceFlag.remove': 'trace_flag_remove',
  'debugLevel.list': 'debug_level_list',
  'debugLevel.get': 'debug_level_get',
  'debugLevel.create': 'debug_level_create',
  'debugLevel.update': 'debug_level_update',
  'debugLevel.delete': 'debug_level_delete',
  'tooling.query': 'tooling_query',
  'tooling.get': 'tooling_get',
  'customLog.sources': 'custom_log_sources',
  'customLog.list': 'custom_log_list',
  'customLog.get': 'custom_log_get',
  'customLog.entry': 'custom_log_entry'
};

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
type AssignsTo<Ui, Core extends Ui> = [Ui, Core];

/**
 * Compile-time proof that the core DTOs assign to their protocol mirrors, which is what lets the
 * client return core results as UI types without mapping code. A field core drops or retypes
 * fails the build here instead of at a webview.
 */
export type CustomLogDtoProof = [
  Holds<Same<typeof core.CUSTOM_LOG_LEVELS, typeof ui.CUSTOM_LOG_LEVELS>>,
  AssignsTo<ui.CustomLogSourceView, core.CustomLogSourceInfo>,
  AssignsTo<ui.CustomLogConfigIssueView, core.CustomLogConfigIssue>,
  AssignsTo<ui.CustomLogColumn, core.CustomLogColumn>,
  AssignsTo<ui.CustomLogRow, core.CustomLogRow>,
  AssignsTo<ui.CustomLogEntry, core.CustomLogEntry>,
  AssignsTo<ui.CustomLogPayloadField, core.CustomLogPayloadField>,
  AssignsTo<ui.CustomLogSourceRef, core.CustomLogSourceRef>,
  AssignsTo<ui.CustomLogApexLogLink, core.CustomLogApexLogLink>,
  Holds<Same<ui.CustomLogStoreView, core.CustomLogStoreInfo>>,
  Holds<Same<ui.CustomLogStoreGapView, core.CustomLogStoreGap>>,
  Holds<Same<ui.CustomLogCaptureOutcomeView, core.CustomLogCaptureOutcome>>,
  Holds<Same<ui.CustomLogCaptureAllowanceView, core.CustomLogCaptureAllowance>>,
  // The view's `failed.code` is a plain string, so the other states are pinned both ways and `failed` one way.
  AssignsTo<ui.CustomLogCaptureStateView, core.CustomLogCaptureState>,
  Holds<
    Same<
      Exclude<ui.CustomLogCaptureStateView, { state: 'failed' }>,
      Exclude<core.CustomLogCaptureState, { state: 'failed' }>
    >
  >,
  AssignsTo<
    ui.CustomLogCaptureView,
    Pick<core.CustomLogCaptureUpdate, 'capture' | 'store' | 'allowance'> & { wanted: boolean }
  >,
  AssignsTo<ui.CustomLogLiveRowsView, Pick<core.CustomLogCaptureUpdate, 'rows' | 'payloadFields'>>
];

export type CustomLogSourcesView = {
  defaultSourceId?: string;
  sources: ui.CustomLogSourceView[];
  issues: ui.CustomLogConfigIssueView[];
};

export type CustomLogListView = {
  source: ui.CustomLogSourceRef;
  columns: ui.CustomLogColumn[];
  rows: ui.CustomLogRow[];
  payloadFields: ui.CustomLogPayloadField[];
  nextCursor: string | null;
  store?: ui.CustomLogStoreView;
};

/** `logPayload` is host-only: the panel keeps its text to open as a document, and the webview gets its state. */
export type CustomLogGetView = {
  source: ui.CustomLogSourceRef;
  log: ui.CustomLogRow;
  logPayload?: core.CustomLogLongValue;
  entryColumns: ui.CustomLogColumn[];
  entries: ui.CustomLogEntry[];
  payloadFields: ui.CustomLogPayloadField[];
  nextCursor: string | null;
  apexLog: ui.CustomLogApexLogLink;
  store?: ui.CustomLogStoreView;
};

function createAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeCoreError(error: unknown, signal?: AbortSignal): unknown {
  if (
    signal?.aborted ||
    (error instanceof Error && 'code' in error && (error.code === 'ABORTED' || error.code === 'cancelled'))
  ) {
    return createAbortError();
  }
  return error;
}

export class CoreClient {
  private readonly core: ApexLogViewerCore;
  private readonly workspaceRoot: () => string | undefined;
  private readonly inFlightOrgLists = new Map<string, PendingInFlight<OrgListItem[]>>();
  private readonly inFlightOrgAuth = new Map<string, PendingInFlight<OrgAuth>>();

  public constructor(options: CoreClientOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? (() => undefined);
    this.core =
      options.core ??
      createApexLogViewerCore({
        surface: 'vscode',
        instrumentation: {
          onCall: event => {
            const properties: Record<string, string> = {
              method: TELEMETRY_METHOD_NAMES[event.method] ?? event.method.replace(/[^a-z0-9_]+/gi, '_'),
              outcome: event.outcome
            };
            if (event.error) properties.code = getTelemetryErrorCode(event.error);
            safeSendEvent('core.request', properties, { durationMs: event.durationMs });
          }
        }
      });
  }

  public doctor(params: DoctorParams = {}, signal?: AbortSignal): Promise<DoctorResult> {
    return this.call(signal, () => this.core.doctor(params, { signal }));
  }

  public orgList(params: OrgListParams = {}, signal?: AbortSignal): Promise<OrgListItem[]> {
    const key = JSON.stringify({ forceRefresh: params.forceRefresh === true });
    const pending = this.inFlightOrgLists.get(key);
    if (pending) return this.observeInFlightRequest(pending, signal);
    return this.observeInFlightRequest(
      this.createInFlightRequest(this.inFlightOrgLists, key, requestSignal =>
        this.core.org.list(params, { signal: requestSignal })
      ),
      signal
    );
  }

  public orgResolve(params: OrgResolveParams = {}, signal?: AbortSignal): Promise<OrgResolveResult> {
    return this.call(signal, () => this.core.org.resolve(params, { signal }));
  }

  public getOrgAuth(params: OrgAuthParams = {}, signal?: AbortSignal): Promise<OrgAuth> {
    const key = JSON.stringify({ username: params.username?.trim() ?? '' });
    const pending = this.inFlightOrgAuth.get(key);
    if (pending) return this.observeInFlightRequest(pending, signal);
    return this.observeInFlightRequest(
      this.createInFlightRequest(this.inFlightOrgAuth, key, requestSignal =>
        this.core.org.getAuth(params, { signal: requestSignal })
      ),
      signal
    );
  }

  public async logsList(params: LogsListParams = {}, signal?: AbortSignal): Promise<ApexLogRow[]> {
    const rows: RuntimeLogRow[] = await this.call(signal, () => this.core.log.list(params, { signal }));
    return rows.map(row => ({
      Id: row.id,
      StartTime: row.startTime ?? '',
      Operation: row.operation ?? '',
      Application: row.application ?? '',
      DurationMilliseconds: row.durationMilliseconds ?? 0,
      Status: row.status ?? '',
      Request: row.request ?? '',
      LogLength: row.logLength ?? 0,
      LogUser: row.logUser ? { Name: row.logUser.name } : undefined
    }));
  }

  public logsSync(params: LogsSyncParams = {}, signal?: AbortSignal): Promise<LogsSyncResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () => this.core.log.sync(normalized, { signal }));
  }

  public logsStatus(params: LogsStatusParams = {}, signal?: AbortSignal): Promise<LogsStatusResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () => this.core.log.status(normalized, { signal }));
  }

  public logsRead(params: LogsReadParams, signal?: AbortSignal): Promise<LogsReadResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () => this.core.log.read(normalized, { signal }));
  }

  public requireLocalLogPath(
    params: {
      logId: string;
      startTime?: string;
      targetOrg?: string;
      workspaceRoot?: string;
    },
    signal?: AbortSignal,
    observe?: (event: ApexLogLifecycleEvent) => void | PromiseLike<void>
  ): Promise<ApexLogLocalFile> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () =>
      this.core.logLifecycle.requireLocalPath(
        {
          workspaceRoot: normalized.workspaceRoot!,
          targetOrg: normalized.targetOrg,
          log: { logId: normalized.logId, startTime: normalized.startTime }
        },
        { signal, observe }
      )
    );
  }

  public availableLocalLogPaths(
    params: {
      logs: readonly { logId: string; startTime?: string }[];
      targetOrg?: string;
      workspaceRoot?: string;
    },
    signal?: AbortSignal
  ): Promise<AvailableLocalPathsResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () =>
      this.core.logLifecycle.availableLocalPaths(
        {
          workspaceRoot: normalized.workspaceRoot!,
          targetOrg: normalized.targetOrg,
          logs: normalized.logs
        },
        { signal }
      )
    );
  }

  public readApexLog(
    params: {
      logId: string;
      startTime?: string;
      targetOrg?: string;
      workspaceRoot?: string;
      maxBytes?: number;
      persistence?: 'required' | 'best-effort';
    },
    signal?: AbortSignal,
    observe?: (event: ApexLogLifecycleEvent) => void | PromiseLike<void>
  ): Promise<ReadApexLogResult> {
    const normalized = this.withWorkspaceRoot(params);
    const request = {
      workspaceRoot: normalized.workspaceRoot!,
      targetOrg: normalized.targetOrg,
      log: { logId: normalized.logId, startTime: normalized.startTime },
      maxBytes: normalized.maxBytes
    };
    return this.call(signal, () => {
      if (normalized.persistence === 'best-effort') {
        return this.core.logLifecycle.read({ ...request, persistence: 'best-effort' }, { signal, observe });
      }
      return this.core.logLifecycle.read({ ...request, persistence: normalized.persistence }, { signal, observe });
    });
  }

  public purgeLocalLogs(
    params: {
      targetOrg?: string;
      workspaceRoot?: string;
      maxAgeMs: number;
      keepLogIds?: readonly string[];
    },
    signal?: AbortSignal
  ): Promise<PurgeApexLogsResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () =>
      this.core.logLifecycle.purge(
        {
          workspaceRoot: normalized.workspaceRoot!,
          targetOrg: normalized.targetOrg,
          policy: { maxAgeMs: normalized.maxAgeMs, keepLogIds: normalized.keepLogIds }
        },
        { signal }
      )
    );
  }

  public logsResolve(params: LogsResolveParams, signal?: AbortSignal): Promise<LogsResolveResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () => this.core.log.resolve(normalized, { signal }));
  }

  public logsDelete(params: LogsDeleteParams, signal?: AbortSignal): Promise<LogsDeleteResult> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () => this.core.log.delete(normalized, { signal }));
  }

  public logsTriage(params: LogsTriageParams, signal?: AbortSignal): Promise<LogsTriageEntry[]> {
    const normalized = this.withWorkspaceRoot(params);
    return this.call(signal, () => this.core.log.triage(normalized, { signal }));
  }

  public usersSearch(params: UserSearchParams = {}, signal?: AbortSignal): Promise<UserSearchResult> {
    return this.call(signal, () => this.core.user.search(params, { signal }));
  }

  public traceFlagStatus(params: TraceFlagStatusParams, signal?: AbortSignal): Promise<TraceFlagTargetStatus> {
    return this.call(signal, () => this.core.traceFlag.status(params, { signal }));
  }

  public traceFlagApply(params: TraceFlagApplyParams, signal?: AbortSignal): Promise<TraceFlagApplyResult> {
    return this.call(signal, () => this.core.traceFlag.apply(params, { signal }));
  }

  public traceFlagRemove(params: TraceFlagRemoveParams, signal?: AbortSignal): Promise<TraceFlagRemoveResult> {
    return this.call(signal, () => this.core.traceFlag.remove(params, { signal }));
  }

  public debugLevelsList(params: DebugLevelListParams = {}, signal?: AbortSignal): Promise<RuntimeDebugLevelRecord[]> {
    return this.call(signal, () => this.core.debugLevel.list(params, { signal }));
  }

  public debugLevelGet(
    params: DebugLevelGetParams,
    signal?: AbortSignal
  ): Promise<RuntimeDebugLevelRecord | undefined> {
    return this.call(signal, () => this.core.debugLevel.get(params, { signal }));
  }

  public debugLevelCreate(params: DebugLevelWriteParams, signal?: AbortSignal): Promise<DebugLevelWriteResult> {
    return this.call(signal, () =>
      this.core.debugLevel.create({ ...params, confirmed: params.confirmed ?? true }, { signal })
    );
  }

  public debugLevelUpdate(params: DebugLevelWriteParams, signal?: AbortSignal): Promise<DebugLevelWriteResult> {
    return this.call(signal, () =>
      this.core.debugLevel.update({ ...params, confirmed: params.confirmed ?? true }, { signal })
    );
  }

  public debugLevelDelete(params: DebugLevelDeleteParams, signal?: AbortSignal): Promise<DebugLevelWriteResult> {
    return this.call(signal, () =>
      this.core.debugLevel.delete({ ...params, confirmed: params.confirmed ?? true }, { signal })
    );
  }

  public toolingQuery(params: ToolingQueryParams, signal?: AbortSignal): Promise<ToolingQueryResult> {
    return this.call(signal, () => this.core.tooling.query(params, { signal }));
  }

  public toolingRequestGet(params: ToolingRequestGetParams, signal?: AbortSignal): Promise<unknown> {
    return this.call(signal, () => this.core.tooling.get(params, { signal }));
  }

  public customLogSources(params: CustomLogSourcesParams, signal?: AbortSignal): Promise<CustomLogSourcesView> {
    return this.call(signal, () => this.core.customLog.sources(params, { signal }));
  }

  public customLogList(params: CustomLogListParams, signal?: AbortSignal): Promise<CustomLogListView> {
    return this.call(signal, () => this.core.customLog.list(params, { signal }));
  }

  public customLogGet(params: CustomLogGetParams, signal?: AbortSignal): Promise<CustomLogGetView> {
    return this.call(signal, () => this.core.customLog.get(params, { signal }));
  }

  /** Host-only: the panel keeps the long values to open as documents and posts `CustomLogLongFieldView`s. */
  public customLogEntry(params: CustomLogEntryParams, signal?: AbortSignal): Promise<CustomLogEntryResult> {
    return this.call(signal, () => this.core.customLog.entry(params, { signal }));
  }

  public dispose(): Promise<void> {
    return this.core.dispose();
  }

  private withWorkspaceRoot<T extends { workspaceRoot?: string }>(params: T): T {
    return params.workspaceRoot ? params : { ...params, workspaceRoot: this.workspaceRoot() ?? os.tmpdir() };
  }

  private async call<TResult>(signal: AbortSignal | undefined, run: () => Promise<TResult>): Promise<TResult> {
    if (signal?.aborted) throw createAbortError();
    try {
      return await run();
    } catch (error) {
      throw normalizeCoreError(error, signal);
    }
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
        error => finish(() => reject(normalizeCoreError(error, signal)))
      );
    });
  }
}

export const runtimeClient = new CoreClient();
