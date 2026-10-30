/**
 * The four operations behind `core.customLog`. With `contracts.ts`, this is the only module of
 * `customLogs/` that code outside the folder may import: `test/customLogsBoundary.test.ts` fails
 * on any other import, and `package.json#exports` exposes neither, so neither the runtime nor an
 * adapter can reach the resolver, the plans or the brands and assemble SOQL for a source.
 *
 * Each operation, in order:
 *   1. parse params at the boundary (ids, limits, levels, `parseSinceExpression`; INVALID_ARGUMENT),
 *   2. load the project mapping fresh (`loadCustomLogsConfig`),
 *   3. get the catalog / pick the source through the registry,
 *   4. run plans with `queryData` (data API) or `toolingQuery` (ApexLog),
 *   5. return contract DTOs.
 * All four are reads, so retries and parallel calls are safe; the registry is the only
 * shared mutable state and it only caches.
 */

import { queryData, toolingQuery } from '../dataQuery.js';
import { errorCodeOf } from '../errors.js';
import { loadCustomLogsConfig } from './config.js';
import { shortHash } from './hash.js';
import {
  CUSTOM_LOG_LEVELS,
  CUSTOM_LOG_LIMITS,
  type CustomLogApexLogLink,
  type CustomLogEntryParams,
  type CustomLogEntryResult,
  type CustomLogFilter,
  type CustomLogGetParams,
  type CustomLogGetResult,
  type CustomLogLevel,
  type CustomLogListParams,
  type CustomLogListResult,
  type CustomLogSourceRef,
  type CustomLogSourcesParams,
  type CustomLogSourcesResult
} from './contracts.js';
import { CANNOT_READ_CODES, customLogError } from './errors.js';
import { parseCustomLogLevel } from './levels.js';
import { BUILTIN_PRESETS, type BuiltinPreset } from './presets.js';
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
import { defaultSourceId, requireSource, requireSourceForRecord, toColumns, toSourceInfo } from './catalog.js';
import { createSourceRegistry, type CustomLogContext } from './registry.js';
import type { ResolvedSource } from './resolved.js';
import { parseSinceExpression } from './since.js';

export type CustomLogApi = {
  sources(ctx: CustomLogContext, params: CustomLogSourcesParams, signal?: AbortSignal): Promise<CustomLogSourcesResult>;
  /**
   * The only ready source when `params.source` is absent. First page when `cursor` is absent.
   * `limit` within `CUSTOM_LOG_LIMITS.list`.
   */
  list(ctx: CustomLogContext, params: CustomLogListParams, signal?: AbortSignal): Promise<CustomLogListResult>;
  /**
   * Header row + one page of entries + ApexLog link, every call (the header read and the
   * link lookup are two small queries, run in parallel with the entries query). For an
   * `entries` source, `logId` is any entry id: core reads its transaction key and pages every
   * entry with that key. `transactionId` finds the transaction by the framework's id instead.
   * `limit` within `CUSTOM_LOG_LIMITS.entries`.
   */
  get(ctx: CustomLogContext, params: CustomLogGetParams, signal?: AbortSignal): Promise<CustomLogGetResult>;
  /** Full message, every mapped detail as a long value, and the raw payload of one entry. */
  entry(ctx: CustomLogContext, params: CustomLogEntryParams, signal?: AbortSignal): Promise<CustomLogEntryResult>;
  /** Drops the registry. Called from the facade's `dispose()`. */
  dispose(): void;
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

function orgIdOf(ctx: CustomLogContext): string {
  const orgId = ctx.connection.getAuthInfoFields().orgId;
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

export function createCustomLogApi(presets: readonly BuiltinPreset[] = BUILTIN_PRESETS): CustomLogApi {
  const registry = createSourceRegistry(presets);

  return {
    async sources(ctx, params, signal) {
      const config = await loadCustomLogsConfig(params.projectDir);
      const catalog = await registry.catalog(ctx, config, { refresh: params.refresh, signal });
      const defaultId = defaultSourceId(catalog);
      return {
        ...(config.projectFile ? { projectFile: config.projectFile } : {}),
        ...(defaultId ? { defaultSourceId: defaultId } : {}),
        sources: catalog.entries.map(toSourceInfo),
        issues: [...config.issues]
      };
    },

    async list(ctx, params, signal) {
      const limit = limitOf(params.limit, CUSTOM_LOG_LIMITS.list);
      const given = {
        minLevel: levelOf(params.filter?.minLevel),
        user: nonBlank(params.filter?.user),
        since: nonBlank(params.filter?.since),
        until: nonBlank(params.filter?.until)
      };
      const window = resolveWindow(params.filter, new Date());
      const config = await loadCustomLogsConfig(params.projectDir);
      return registry.withSource(
        ctx,
        config,
        catalog => requireSource(catalog, nonBlank(params.source)),
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
          const listed = source.shape.kind === 'transactions' ? source.shape.transaction : source.shape.entry;
          return {
            source: sourceRef(source),
            columns: toColumns(listed.columns),
            rows: page.items,
            payloadFields: page.payloadFields,
            nextCursor: cursor.next(page.next, resolved)
          };
        },
        signal
      );
    },

    async get(ctx, params, signal) {
      const limit = limitOf(params.limit, CUSTOM_LOG_LIMITS.entries);
      const minLevel = levelOf(params.minLevel);
      const logId = params.logId === undefined ? undefined : parseRecordId(params.logId, 'logId');
      const config = await loadCustomLogsConfig(params.projectDir);
      const sourceId = nonBlank(params.source);
      return registry.withSource(
        ctx,
        config,
        catalog => {
          if (logId === undefined) return requireSource(catalog, sourceId);
          const owner = requireSourceForRecord(catalog, sourceId, logId);
          if (owner.source.shape.kind === 'transactions' && owner.level === 'entry') {
            wrongRecordLevel(
              `${logId} is a ${owner.source.shape.entry.object} id. ` +
                `Pass the ${owner.source.shape.transaction.object} id from the entry's logId field.`
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
      );
    },

    async entry(ctx, params, signal) {
      const entryId = parseRecordId(params.entryId, 'entryId');
      const config = await loadCustomLogsConfig(params.projectDir);
      return registry.withSource(
        ctx,
        config,
        catalog => {
          const owner = requireSourceForRecord(catalog, nonBlank(params.source), entryId);
          const { shape } = owner.source;
          if (owner.level !== 'entry') {
            wrongRecordLevel(
              `${entryId} is a ${shape.kind === 'transactions' ? shape.transaction.object : shape.entry.object} id. ` +
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
      );
    },

    dispose: () => registry.clear()
  };
}

async function findTransaction(
  ctx: CustomLogContext,
  source: ResolvedSource,
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
