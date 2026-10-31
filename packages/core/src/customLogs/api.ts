/**
 * The five operations behind `core.customLog`. With `contracts.ts`, this is the only module of
 * `customLogs/` that code outside the folder may import: `test/customLogsBoundary.test.ts` fails
 * on any other import, and `package.json#exports` exposes neither, so neither the runtime nor an
 * adapter can reach the resolver, the plans or the brands and assemble SOQL for a source.
 *
 * Each read, in order:
 *   1. parse params at the boundary (ids, limits, levels, `parseSinceExpression`; INVALID_ARGUMENT),
 *   2. load the project mapping fresh (`loadCustomLogsConfig`),
 *   3. route by the kind of the named source, once per call:
 *        an `events` source reads the local store (`events/read.ts`) and never connects;
 *        any other call gets the catalog / picks the source through the registry,
 *   4. run plans with `queryData` (data API) or `toolingQuery` (ApexLog),
 *   5. return contract DTOs.
 * The four reads are idempotent, so retries and parallel calls are safe; the registry and the store
 * handles are the only shared mutable state and they only cache. `capture` is the one long-lived
 * operation: it checks its params and its source before it connects, then hands the run to the
 * capture hub, which shares one subscription per event object among every caller of this instance.
 */

import path from 'node:path';

import { queryData, toolingQuery } from '../dataQuery.js';
import { AlvError, awaitWithAbort, errorCodeOf } from '../errors.js';
import { loadCustomLogsConfig, type ParsedCustomLogsConfig } from './config.js';
import { shortHash } from './hash.js';
import {
  CUSTOM_LOG_LEVELS,
  CUSTOM_LOG_LIMITS,
  type CustomLogApexLogLink,
  type CustomLogCaptureParams,
  type CustomLogCaptureResult,
  type CustomLogCaptureUpdate,
  type CustomLogEntryParams,
  type CustomLogEntryResult,
  type CustomLogFilter,
  type CustomLogGetParams,
  type CustomLogGetResult,
  type CustomLogLevel,
  type CustomLogListParams,
  type CustomLogListResult,
  type CustomLogSourceInfo,
  type CustomLogSourceRef,
  type CustomLogSourcesParams,
  type CustomLogSourcesResult
} from './contracts.js';
import {
  defaultSourceId,
  requireRecordSource,
  requireSource,
  requireSourceForRecord,
  toColumns,
  toSourceInfo,
  unknownSource
} from './catalog.js';
import { CANNOT_READ_CODES, customLogError } from './errors.js';
import { createCaptureHub, systemClock, type CaptureDeps, type CaptureRunEvent } from './events/capture.js';
import { DRAIN_MAX_MS, type Allowance } from './events/captureRules.js';
import { createCometdTransport } from './events/cometd.js';
import { parseEventRowId, type EventPosition } from './events/ids.js';
import {
  decodeEventRows,
  entryEvent,
  getEvent,
  listEvents,
  openSnapshot,
  requireFilterable,
  storeInfoOf,
  type EventSnapshot
} from './events/read.js';
import { openEventStore, type EventStore, type EventStoreLocation } from './events/store.js';
import { parseCustomLogLevel } from './levels.js';
import { BUILTIN_PRESETS, qualifyPath, type BuiltinPreset } from './presets.js';
import {
  apexLogLinkPlan,
  decodeCursor,
  encodeCursor,
  entriesPlan,
  entriesScopeOf,
  entryPlan,
  listPlan,
  parseRecordId,
  rowPlan,
  transactionLookupPlan,
  type CursorBinding,
  type CursorPayload,
  type Page,
  type QueryPlan,
  type RecordId
} from './queries.js';
import { createSourceRegistry, sourceCandidates, type CustomLogContext } from './registry.js';
import { namespaceOf, resolveDefinition, type SourceCandidate } from './resolve.js';
import {
  assertNever,
  headerObject,
  isEventSource,
  listedObject,
  type CatalogHead,
  type ResolvedEventSource,
  type ResolvedRecordSource,
  type ResolvedSource,
  type SourceCatalog
} from './resolved.js';
import type { ObjectDescribe } from './schema.js';
import { parseSinceExpression } from './since.js';

/**
 * What a call knows of its org before it connects: the username, resolved locally from the sf alias
 * store, and a lazy way to connect. Record sources always connect (`use`). An event source's `list`,
 * `get` and `entry` read the local store and connect only to look up an ApexLog link, so they work
 * offline.
 */
export type CustomLogEnv = {
  /** Keys the store's org directory and the registry's memo. Resolving it makes no network call. */
  readonly username: string;
  /** Run `run` with the org connection, retrying once on a rejected session. The connection opens here. */
  use<T>(run: (ctx: CustomLogContext) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The connection itself, for a long-lived subscription. `fresh` drops the cached one first. */
  connection(options?: { fresh?: boolean; signal?: AbortSignal }): Promise<CustomLogContext>;
  /** Which adapter is asking; a capture lease records it so a standby panel can say who captures. */
  readonly surface: 'vscode' | 'cli';
};

/** Re-exported so the facade can type `onCapture` without importing `events/*`, which the boundary test forbids. */
export type { CaptureRunEvent } from './events/capture.js';

export type CustomLogApi = {
  sources(env: CustomLogEnv, params: CustomLogSourcesParams, signal?: AbortSignal): Promise<CustomLogSourcesResult>;
  /**
   * The only ready source when `params.source` is absent (never an event source). First page when
   * `cursor` is absent. `limit` within `CUSTOM_LOG_LIMITS.list`. An event source reads the local store
   * and never connects.
   */
  list(env: CustomLogEnv, params: CustomLogListParams, signal?: AbortSignal): Promise<CustomLogListResult>;
  /**
   * Header row + one page of entries + ApexLog link, every call (the header read and the
   * link lookup are two small queries, run in parallel with the entries query). For an
   * `entries` source, `logId` is any entry id: core reads its transaction key and pages every
   * entry with that key. `transactionId` finds the transaction by the framework's id instead.
   * `limit` within `CUSTOM_LOG_LIMITS.entries`. For an event source `logId` is an event id, the
   * transaction is read from the local store, and only the link lookup connects.
   */
  get(env: CustomLogEnv, params: CustomLogGetParams, signal?: AbortSignal): Promise<CustomLogGetResult>;
  /** Full message, every mapped detail as a long value, and the raw payload of one entry. */
  entry(env: CustomLogEnv, params: CustomLogEntryParams, signal?: AbortSignal): Promise<CustomLogEntryResult>;
  /**
   * Stores the delivered events of an event source and tells `onUpdate` what was stored. Needs a
   * project directory, and the connection only once the params and the source check out. Resolves per
   * `params.follow` (see `CaptureHub.watch`); an aborted signal resolves with outcome `aborted`, also
   * before the run starts. Rejects with INVALID_ARGUMENT, CUSTOM_LOG_SOURCE_NOT_FOUND,
   * CUSTOM_LOG_NOT_EVENT_SOURCE, CUSTOM_LOG_SOURCE_UNAVAILABLE, CUSTOM_LOG_UNSUPPORTED_FILTER,
   * CUSTOM_LOG_STORE_UNAVAILABLE, or the run's own CUSTOM_LOG_* failure.
   */
  capture(env: CustomLogEnv, params: CustomLogCaptureParams, options?: CaptureOptions): Promise<CustomLogCaptureResult>;
  /** Ends every capture run (their leases are released), then drops the registry and the store handles. */
  dispose(): Promise<void>;
};

export type CaptureOptions = {
  signal?: AbortSignal;
  /** Every state change and every durable batch, decoded through the requested source. */
  onUpdate?: (update: CustomLogCaptureUpdate) => void;
};

/** What the owner of the api instance wants to hear about capture runs. */
export type CustomLogApiHooks = {
  /** One `start` and one `end` per run, never per event. */
  onCapture?: (event: CaptureRunEvent) => void;
  /** A watcher callback, the row decoder or `onCapture` threw. The watcher is detached; the run goes on. */
  onCallbackError?: (error: unknown) => void;
};

/** ApexLog is a Tooling object some users cannot see at all: a Standard User answers INVALID_TYPE. */
const APEX_LOG_UNREADABLE: ReadonlySet<string> = new Set([...CANNOT_READ_CODES, 'INVALID_TYPE']);

function limitOf(value: number | undefined, limits: { readonly default: number; readonly max: number }): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(limits.max, parsed)) : limits.default;
}

function nonBlank(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

function levelOf(value: CustomLogLevel | undefined): CustomLogLevel | undefined {
  if (value === undefined) return undefined;
  const level = parseCustomLogLevel(value);
  if (!level) {
    throw customLogError(
      'INVALID_ARGUMENT',
      `"${String(value)}" is not a level. Use one of ${CUSTOM_LOG_LEVELS.join(', ')}.`
    );
  }
  return level;
}

function keepOf(paths: readonly string[] | undefined): ReadonlySet<string> | undefined {
  const kept = (paths ?? []).map(path => path.trim()).filter(Boolean);
  return kept.length > 0 ? new Set(kept) : undefined;
}

function sourceRef(source: ResolvedSource): CustomLogSourceRef {
  return { id: source.id, label: source.label, shape: source.shape.kind };
}

const authOrgId = (ctx: CustomLogContext): string | undefined => ctx.connection.getAuthInfoFields().orgId;

function orgIdOf(ctx: CustomLogContext): string {
  const orgId = authOrgId(ctx);
  if (!orgId)
    throw customLogError(
      'CUSTOM_LOG_INVALID_CURSOR',
      'The org id of this connection is unknown, so a cursor cannot be bound to it.'
    );
  return orgId;
}

async function run<T>(ctx: CustomLogContext, plan: QueryPlan<T>, signal: AbortSignal | undefined): Promise<T> {
  const records =
    plan.api === 'tooling'
      ? (await toolingQuery(ctx.connection, plan.soql, signal)).records
      : (await queryData(ctx.connection, plan.soql, { maxRecords: plan.maxRecords, signal })).records;
  return plan.decode(records);
}

async function apexLogFor(
  ctx: CustomLogContext,
  requestId: string | undefined,
  signal: AbortSignal | undefined
): Promise<CustomLogApexLogLink> {
  if (!requestId) return { state: 'noRequestId' };
  try {
    return await run(ctx, apexLogLinkPlan(requestId), signal);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code && APEX_LOG_UNREADABLE.has(code)) return { state: 'unavailable', reason: 'noAccess' };
    throw error;
  }
}

function notFound(what: string): never {
  throw customLogError('CUSTOM_LOG_RECORD_NOT_FOUND', `${what} was not found, or this user cannot read it.`);
}

/** A record id of the other level was passed. The message says what it is and which id to pass instead. */
function wrongRecordLevel(message: string): never {
  throw customLogError('CUSTOM_LOG_RECORD_NOT_FOUND', message);
}

/**
 * The cursor of one kind of page, bound to this org, source, mapping and the filters the page is
 * read under. `after` reads the caller's token (CUSTOM_LOG_INVALID_CURSOR on any mismatch); `next`
 * writes the token of the following page, or null after the last one.
 */
function pageCursor(ctx: CustomLogContext, source: ResolvedSource, kind: CursorBinding['k'], filters: object) {
  const binding: CursorBinding = { o: orgIdOf(ctx), s: source.id, m: source.digest, k: kind, f: shortHash(filters) };
  return {
    after: (token: string | undefined): CursorPayload | undefined => (token ? decodeCursor(token, binding) : undefined),
    next: (position: Page<unknown>['next'], window: NonNullable<CursorPayload['w']> = {}): string | null =>
      position
        ? encodeCursor({ v: 1, ...binding, ...(Object.keys(window).length > 0 ? { w: window } : {}), ...position })
        : null
  };
}

function resolveWindow(filter: CustomLogFilter | undefined, now: Date): { since?: string; until?: string } {
  const since = nonBlank(filter?.since);
  const until = nonBlank(filter?.until);
  return {
    ...(since ? { since: parseSinceExpression(since, now) } : {}),
    ...(until ? { until: parseSinceExpression(until, now) } : {})
  };
}

// ---------------------------------------------------------------------------------------------
// Event sources: found from the definition, resolved against the stored describe

/** A named source that holds platform events, and the store object it reads. */
type EventCandidate = { readonly candidate: SourceCandidate; readonly object: string };

/** The store object of a candidate that holds platform events; none for a record source. */
function eventCandidateOf(candidate: SourceCandidate): EventCandidate | undefined {
  const { shape } = candidate.definition;
  switch (shape.kind) {
    case 'events':
      return { candidate, object: qualifyPath(shape.event.object, namespaceOf(candidate)) };
    case 'transactions':
    case 'entries':
      return undefined;
    default:
      return assertNever(shape, 'source shape');
  }
}

/**
 * The source `sourceId` names when it holds platform events. None for no id, an unknown id, or a
 * record source: those take the catalog path, which also words the unknown-id error.
 */
function namedEventCandidate(
  config: ParsedCustomLogsConfig,
  presets: readonly BuiltinPreset[],
  sourceId: string | undefined
): EventCandidate | undefined {
  if (sourceId === undefined) return undefined;
  const candidate = sourceCandidates(config, presets).find(item => item.definition.id === sourceId);
  return candidate && eventCandidateOf(candidate);
}

function notEventSource(sourceId: string): never {
  throw customLogError('CUSTOM_LOG_NOT_EVENT_SOURCE', `Log source "${sourceId}" is not an event source.`);
}

/**
 * The event source `sourceId` names, found in the project and the presets alone: an unknown id or a
 * record source is refused here, before any connection.
 */
function requireEventCandidate(
  config: ParsedCustomLogsConfig,
  presets: readonly BuiltinPreset[],
  sourceId: string
): EventCandidate {
  const candidates = sourceCandidates(config, presets);
  const candidate = candidates.find(item => item.definition.id === sourceId);
  if (!candidate) {
    return unknownSource(
      sourceId,
      candidates.map(item => item.definition.id)
    );
  }
  return eventCandidateOf(candidate) ?? notEventSource(sourceId);
}

function requireEventSource(catalog: SourceCatalog, sourceId: string): ResolvedEventSource {
  const source = requireSource(catalog, sourceId);
  return isEventSource(source) ? source : notEventSource(sourceId);
}

const refOf = ({ candidate: { definition } }: EventCandidate): CustomLogSourceRef => ({
  id: definition.id,
  label: definition.label,
  shape: definition.shape.kind
});

/**
 * The source as the stored describe lets this user read it, with no EntityDefinition lookup and no
 * preset fingerprint check: the store exists only if the mapping passed both when it was captured.
 */
function resolveOffline(
  { candidate, object }: EventCandidate,
  describe: ObjectDescribe,
  username: string
): ResolvedEventSource {
  const { definition } = candidate;
  const entry = resolveDefinition(definition, candidate.origin, namespaceOf(candidate), new Map([[object, describe]]));
  return requireEventSource({ username, entries: [entry] }, definition.id);
}

/**
 * `DailyDeliveredPlatformEvents` from `/limits`. An org that will not say, or answers something
 * unreadable, gives no allowance and the run spends its fixed budget instead, so this never throws.
 */
async function readAllowance(ctx: CustomLogContext, signal: AbortSignal): Promise<Allowance | undefined> {
  try {
    const limit = (await awaitWithAbort(ctx.connection.limits(), signal)).DailyDeliveredPlatformEvents;
    return limit && Number.isFinite(limit.Remaining) && Number.isFinite(limit.Max)
      ? { remaining: limit.Remaining, max: limit.Max }
      : undefined;
  } catch {
    return undefined;
  }
}

function drainBoundOf(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > DRAIN_MAX_MS) {
    throw customLogError(
      'INVALID_ARGUMENT',
      `maxDurationMs must be a whole number of milliseconds from 1 to ${DRAIN_MAX_MS}, not ${String(value)}.`
    );
  }
  return value;
}

/** The directory of the project: where `sfdx-project.json` was found, else the caller's `projectDir`. */
function storeRoot(config: ParsedCustomLogsConfig, projectDir: string | undefined): string | undefined {
  if (config.projectFile) return path.dirname(config.projectFile);
  return projectDir === undefined ? undefined : path.resolve(projectDir);
}

/** An event id names an event source's row, so it cannot say which source without `--source`. */
function refuseEventIdWithoutSource(id: string | undefined, sourceId: string | undefined): void {
  if (sourceId === undefined && id !== undefined && parseEventRowId(id)) {
    throw customLogError(
      'CUSTOM_LOG_SOURCE_REQUIRED',
      `${id} is an event id. Pass --source <event source> so core knows which store to read.`
    );
  }
}

function eventPositionOf(value: string, what: string, sourceId: string): EventPosition {
  const position = parseEventRowId(value);
  if (!position) {
    throw customLogError(
      'INVALID_ARGUMENT',
      `${what} must be an event id of log source "${sourceId}", as custom-log list returns it.`
    );
  }
  return position;
}

export function createCustomLogApi(
  options: { presets?: readonly BuiltinPreset[]; hooks?: CustomLogApiHooks } = {}
): CustomLogApi {
  const { presets = BUILTIN_PRESETS, hooks = {} } = options;
  const registry = createSourceRegistry(presets);
  const hub = createCaptureHub();
  /** One handle per event object keeps its line index warm across pages, and gives `list` and `capture` the same store. */
  const stores = new Map<string, EventStore>();

  const storeAt = ({ root, username, object }: EventStoreLocation): EventStore => {
    const key = JSON.stringify([root, username, object]);
    let store = stores.get(key);
    if (!store) {
      store = openEventStore({ root, username, object });
      stores.set(key, store);
    }
    return store;
  };

  /** Where the events of `found` are kept: the project, the org's username, and the object as the config wrote it. */
  const locationOf = (
    env: CustomLogEnv,
    config: ParsedCustomLogsConfig,
    projectDir: string | undefined,
    found: EventCandidate
  ): EventStoreLocation => {
    const root = storeRoot(config, projectDir);
    if (!root) {
      throw customLogError(
        'CUSTOM_LOG_STORE_UNAVAILABLE',
        'Open a folder or run from a Salesforce project to keep captured events.'
      );
    }
    return { root, username: env.username, object: found.object };
  };

  const snapshotOf = (
    env: CustomLogEnv,
    config: ParsedCustomLogsConfig,
    projectDir: string | undefined,
    found: EventCandidate
  ): Promise<EventSnapshot> =>
    openSnapshot({
      store: storeAt(locationOf(env, config, projectDir, found)),
      retentionDays: config.eventRetentionDays,
      ref: refOf(found),
      resolve: describe => resolveOffline(found, describe, env.username)
    });

  /**
   * What `sources` says of an event source's history. A store that cannot be read is left out here
   * and named by the `list` that needs it, so one bad file does not hide the record sources.
   */
  const storeInfoOfHead = async (
    env: CustomLogEnv,
    config: ParsedCustomLogsConfig,
    projectDir: string | undefined,
    head: CatalogHead
  ): Promise<CustomLogSourceInfo['store']> => {
    const root = storeRoot(config, projectDir);
    if (!root || !('event' in head.objects)) return undefined;
    try {
      const store = storeAt({ root, username: env.username, object: head.objects.event });
      return storeInfoOf(await store.coverage(), config.eventRetentionDays);
    } catch (error) {
      if (error instanceof AlvError && error.code === 'CUSTOM_LOG_STORE_UNAVAILABLE') return undefined;
      throw error;
    }
  };

  /** What a run needs from outside the hub. The hub keeps the first caller's, so a caller that joins a run shares that connection and retention. */
  const captureDeps = (env: CustomLogEnv, config: ParsedCustomLogsConfig): CaptureDeps => ({
    createTransport: createCometdTransport,
    connect: async ({ fresh, signal }) => {
      const ctx = await env.connection({ fresh, signal });
      const orgId = authOrgId(ctx);
      if (!orgId) {
        throw customLogError(
          'CUSTOM_LOG_CAPTURE_FAILED',
          'The org id of this connection is unknown, so captured events cannot be tied to an org.'
        );
      }
      return { ctx, orgId };
    },
    describe: async (ctx, object, signal) => {
      const described = await registry.describe(ctx, object, signal);
      if (!described) {
        throw customLogError(
          'CUSTOM_LOG_SOURCE_UNAVAILABLE',
          `${object} is not visible to this user any more, so its events cannot be captured.`
        );
      }
      return described;
    },
    openStore: storeAt,
    storeInfo: coverage => storeInfoOf(coverage, config.eventRetentionDays),
    readAllowance,
    decodeRows: (source, events, { filter, payloadFields }) =>
      decodeEventRows(source, events, { ...filter, keep: keepOf(payloadFields) }),
    retentionDays: config.eventRetentionDays,
    surface: env.surface,
    clock: systemClock,
    onRunEvent: hooks.onCapture,
    onCallbackError: hooks.onCallbackError
  });

  /** The ApexLog link of an event is the only online lookup an event read makes; failing to reach the org leaves the event readable. */
  const apexLogOf =
    (env: CustomLogEnv, signal: AbortSignal | undefined) =>
    async (requestId: string | undefined): Promise<CustomLogApexLogLink> => {
      if (!requestId) return { state: 'noRequestId' };
      try {
        return await env.use(ctx => apexLogFor(ctx, requestId, signal), signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return { state: 'unavailable', reason: 'offline' };
      }
    };

  return {
    async sources(env, params, signal) {
      const config = await loadCustomLogsConfig(params.projectDir);
      const catalog = await env.use(ctx => registry.catalog(ctx, config, { refresh: params.refresh, signal }), signal);
      const defaultId = defaultSourceId(catalog);
      const sources = await Promise.all(
        catalog.entries.map(async entry => {
          const store = await storeInfoOfHead(env, config, params.projectDir, entry.head);
          return { ...toSourceInfo(entry), ...(store ? { store } : {}) };
        })
      );
      return {
        ...(config.projectFile ? { projectFile: config.projectFile } : {}),
        ...(defaultId ? { defaultSourceId: defaultId } : {}),
        sources,
        issues: [...config.issues]
      };
    },

    async list(env, params, signal) {
      const limit = limitOf(params.limit, CUSTOM_LOG_LIMITS.list);
      const given = {
        minLevel: levelOf(params.filter?.minLevel),
        user: nonBlank(params.filter?.user),
        since: nonBlank(params.filter?.since),
        until: nonBlank(params.filter?.until)
      };
      const window = resolveWindow(params.filter, new Date());
      const config = await loadCustomLogsConfig(params.projectDir);
      const sourceId = nonBlank(params.source);
      const events = namedEventCandidate(config, presets, sourceId);
      if (events) {
        return listEvents(await snapshotOf(env, config, params.projectDir, events), {
          limit,
          given,
          window,
          cursor: params.cursor,
          keep: keepOf(params.payloadFields)
        });
      }
      return env.use(
        ctx =>
          registry.withSource(
            ctx,
            config,
            catalog => requireRecordSource(catalog, sourceId),
            async source => {
              const cursor = pageCursor(ctx, source, 'list', given);
              const after = cursor.after(params.cursor);
              const resolved = after ? (after.w ?? {}) : window;
              const page = await run(
                ctx,
                listPlan(source, {
                  limit,
                  filter: { minLevel: given.minLevel, user: given.user, ...resolved },
                  after,
                  keep: keepOf(params.payloadFields)
                }),
                signal
              );
              return {
                source: sourceRef(source),
                columns: toColumns(listedObject(source.shape).columns),
                rows: page.items,
                payloadFields: page.payloadFields,
                nextCursor: cursor.next(page.next, resolved)
              };
            },
            signal
          ),
        signal
      );
    },

    async get(env, params, signal) {
      const limit = limitOf(params.limit, CUSTOM_LOG_LIMITS.entries);
      const minLevel = levelOf(params.minLevel);
      const sourceId = nonBlank(params.source);
      refuseEventIdWithoutSource(params.logId, sourceId);
      const config = await loadCustomLogsConfig(params.projectDir);
      const events = namedEventCandidate(config, presets, sourceId);
      if (events) {
        const anchor =
          params.logId === undefined
            ? { transactionId: params.transactionId ?? '' }
            : { logId: eventPositionOf(params.logId, 'logId', events.candidate.definition.id) };
        return getEvent(
          await snapshotOf(env, config, params.projectDir, events),
          { limit, minLevel, cursor: params.cursor, keep: keepOf(params.payloadFields), anchor },
          apexLogOf(env, signal)
        );
      }
      const logId = params.logId === undefined ? undefined : parseRecordId(params.logId, 'logId');
      return env.use(
        ctx =>
          registry.withSource(
            ctx,
            config,
            catalog => {
              if (logId === undefined) return requireRecordSource(catalog, sourceId);
              const owner = requireSourceForRecord(catalog, sourceId, logId);
              const header = headerObject(owner.source.shape);
              if (header && owner.level === 'entry') {
                wrongRecordLevel(
                  `${logId} is a ${owner.source.shape.entry.object} id. ` +
                    `Pass the ${header.object} id from the entry's logId field.`
                );
              }
              return owner.source;
            },
            async source => {
              const id = logId ?? (await findTransaction(ctx, source, params.transactionId ?? '', signal));
              const found = await run(ctx, rowPlan(source, id), signal);
              if (!found) notFound(`Log ${id}`);
              const { row } = found;
              const scope = entriesScopeOf(source, id, row.transactionId);
              const { kind } = scope;
              const scoped = scope.kind === 'transactionKey' ? { kind, value: scope.value } : { kind, id: scope.id };
              const cursor = pageCursor(ctx, source, 'entries', { scope: scoped, minLevel });
              const after = cursor.after(params.cursor);
              const [page, apexLog] = await Promise.all([
                run(
                  ctx,
                  entriesPlan(source, scope, { limit, minLevel, after, keep: keepOf(params.payloadFields) }),
                  signal
                ),
                apexLogFor(ctx, row.requestId, signal)
              ]);
              return {
                source: sourceRef(source),
                log: row,
                ...(found.logPayload ? { logPayload: found.logPayload } : {}),
                entryColumns: toColumns(source.shape.entry.columns),
                entries: page.items,
                payloadFields: page.payloadFields,
                nextCursor: cursor.next(page.next),
                apexLog
              };
            },
            signal
          ),
        signal
      );
    },

    async entry(env, params, signal) {
      const sourceId = nonBlank(params.source);
      refuseEventIdWithoutSource(params.entryId, sourceId);
      const config = await loadCustomLogsConfig(params.projectDir);
      const events = namedEventCandidate(config, presets, sourceId);
      if (events) {
        return entryEvent(
          await snapshotOf(env, config, params.projectDir, events),
          eventPositionOf(params.entryId, 'entryId', events.candidate.definition.id)
        );
      }
      const entryId = parseRecordId(params.entryId, 'entryId');
      return env.use(
        ctx =>
          registry.withSource(
            ctx,
            config,
            catalog => {
              const owner = requireSourceForRecord(catalog, sourceId, entryId);
              const { shape } = owner.source;
              if (owner.level !== 'entry') {
                wrongRecordLevel(
                  `${entryId} is a ${listedObject(shape).object} id. ` +
                    `Pass a ${shape.entry.object} id from the entries that custom-log get returns.`
                );
              }
              return owner.source;
            },
            async source => {
              const found = await run(ctx, entryPlan(source, entryId), signal);
              if (!found) notFound(`Entry ${entryId}`);
              return {
                source: sourceRef(source),
                logId: found.logId,
                entry: found.entry,
                details: found.details,
                rawPayload: found.rawPayload
              };
            },
            signal
          ),
        signal
      );
    },

    async capture(env, params, { signal, onUpdate } = {}) {
      const sourceId = nonBlank(params.source);
      if (!sourceId) {
        throw customLogError(
          'INVALID_ARGUMENT',
          'capture needs a source: an event source is never chosen implicitly, because capturing spends the org delivery allocation.'
        );
      }
      const filter = { minLevel: levelOf(params.filter?.minLevel), user: nonBlank(params.filter?.user) };
      const maxDurationMs = drainBoundOf(params.maxDurationMs);
      const config = await loadCustomLogsConfig(params.projectDir);
      const found = requireEventCandidate(config, presets, sourceId);
      const location = locationOf(env, config, params.projectDir, found);

      let source: ResolvedEventSource;
      try {
        source = await env.use(
          ctx =>
            registry.withSource(
              ctx,
              config,
              catalog => requireEventSource(catalog, sourceId),
              async resolved => resolved,
              signal
            ),
          signal
        );
      } catch (error) {
        if (!signal?.aborted) throw error;
        return {
          source: refOf(found),
          outcome: 'aborted',
          delivered: 0,
          stored: 0,
          newGaps: [],
          store: storeInfoOf(await storeAt(location).coverage(), config.eventRetentionDays)
        };
      }
      requireFilterable(source, filter);

      return hub.watch(
        location,
        {
          source,
          params: {
            follow: params.follow,
            initial: params.initial,
            filter,
            payloadFields: params.payloadFields,
            maxDurationMs
          },
          signal: signal ?? new AbortController().signal,
          onUpdate
        },
        captureDeps(env, config)
      );
    },

    async dispose() {
      await hub.dispose();
      registry.clear();
      stores.clear();
    }
  };
}

async function findTransaction(
  ctx: CustomLogContext,
  source: ResolvedRecordSource,
  transactionId: string,
  signal: AbortSignal | undefined
): Promise<RecordId> {
  const ids = await run(ctx, transactionLookupPlan(source, transactionId), signal);
  if (ids.length === 0) notFound(`Transaction ${transactionId}`);
  if (ids.length > 1) {
    throw customLogError(
      'CUSTOM_LOG_AMBIGUOUS_TRANSACTION',
      `Several logs carry transaction id ${transactionId} (${ids.join(', ')}). Pass one with --log-id.`
    );
  }
  return ids[0]!;
}
