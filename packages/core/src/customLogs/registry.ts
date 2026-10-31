/**
 * Shared state: one `SourceRegistry` per core instance. Per username it keeps a `SchemaMemo`
 * (metadata answers, misses included) and the catalogs built from it, keyed by config
 * fingerprint. Pending promises are shared by concurrent callers, like `createOrgConnections`,
 * and a rejected one is evicted. Nothing else caches schema facts.
 */

import type { Connection } from '@salesforce/core';

import { awaitWithAbort, errorCodeOf, throwIfAborted } from '../errors.js';
import type { ParsedCustomLogsConfig } from './config.js';
import type { BuiltinPreset } from './presets.js';
import { definitionObjects, locateSource, namespaceOf, objectNames, type SourceCandidate } from './resolve.js';
import type { ResolvedSource, SourceCatalog } from './resolved.js';
import {
  createSchemaMemo,
  createSchemaReader,
  memoizedSchemaReader,
  type ObjectDescribe,
  type SchemaMemo
} from './schema.js';

/** `orgCall`'s context. The cursor's org binding reads `connection.getAuthInfoFields().orgId`. */
export type CustomLogContext = { connection: Connection; username: string };

export type SourceRegistry = {
  /**
   * The catalog for this org and config: per username, the `SchemaMemo` plus catalogs keyed by
   * `config.fingerprint`, shared by concurrent callers, evicted on rejection. `refresh` drops the
   * username's memo and catalogs first.
   */
  catalog(
    ctx: CustomLogContext,
    config: ParsedCustomLogsConfig,
    options: { refresh?: boolean; signal?: AbortSignal }
  ): Promise<SourceCatalog>;
  /**
   * One object's describe through this username's memo, so a capture reads what the catalog already
   * asked. `undefined` when describe answers NOT_FOUND.
   */
  describe(ctx: CustomLogContext, object: string, signal?: AbortSignal): Promise<ObjectDescribe | undefined>;
  /**
   * Run a query against a resolved source. If Salesforce rejects it with INVALID_FIELD or
   * INVALID_TYPE (schema or FLS changed since resolution), drop the username's memo and catalogs,
   * re-resolve once and retry. Converges instead of serving a stale catalog until restart.
   */
  withSource<S extends ResolvedSource, T>(
    ctx: CustomLogContext,
    config: ParsedCustomLogsConfig,
    pick: (catalog: SourceCatalog) => S,
    run: (source: S) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
  clear(): void;
};

type OrgState = { memo: SchemaMemo; catalogs: Map<string, Promise<SourceCatalog>> };

const MAX_CATALOGS_PER_ORG = 8;
const DRIFT_CODES: ReadonlySet<string> = new Set(['INVALID_FIELD', 'INVALID_TYPE']);

/**
 * Every source a call can name, in catalog order: the project's, then the built-ins it does not
 * replace. A project source that reuses a built-in id replaces it.
 */
export function sourceCandidates(
  config: ParsedCustomLogsConfig,
  presets: readonly BuiltinPreset[]
): readonly SourceCandidate[] {
  const replaced = new Set<string>(config.sources.map(source => source.id));
  return [
    ...config.sources.map((definition): SourceCandidate => ({ origin: 'config', definition })),
    ...presets
      .filter(preset => !replaced.has(preset.definition.id))
      .map((preset): SourceCandidate => ({ origin: 'builtin', ...preset }))
  ];
}

export function createSourceRegistry(presets: readonly BuiltinPreset[]): SourceRegistry {
  const orgs = new Map<string, OrgState>();

  const build = async (
    ctx: CustomLogContext,
    config: ParsedCustomLogsConfig,
    memo: SchemaMemo
  ): Promise<SourceCatalog> => {
    const reader = memoizedSchemaReader(createSchemaReader(ctx.connection), memo);
    const candidates = sourceCandidates(config, presets);
    const mapped = config.sources.flatMap(source => objectNames(definitionObjects(source, '')));
    const configured = new Set(mapped.map(name => name.toLowerCase()));
    await reader.existingObjects(
      candidates.flatMap(candidate => objectNames(definitionObjects(candidate.definition, namespaceOf(candidate))))
    );

    const entries = await Promise.all(candidates.map(candidate => locateSource(candidate, reader, configured)));
    return { username: ctx.username, entries };
  };

  const stateOf = (username: string): OrgState => {
    let state = orgs.get(username);
    if (!state) {
      state = { memo: createSchemaMemo(), catalogs: new Map() };
      orgs.set(username, state);
    }
    return state;
  };

  const catalog: SourceRegistry['catalog'] = async (ctx, config, options) => {
    throwIfAborted(options.signal);
    if (options.refresh) orgs.delete(ctx.username);
    const state = stateOf(ctx.username);
    let pending = state.catalogs.get(config.fingerprint);
    if (!pending) {
      pending = build(ctx, config, state.memo);
      state.catalogs.set(config.fingerprint, pending);
      const own = pending;
      own.catch(() => {
        if (state.catalogs.get(config.fingerprint) === own) state.catalogs.delete(config.fingerprint);
      });
      while (state.catalogs.size > MAX_CATALOGS_PER_ORG) state.catalogs.delete(state.catalogs.keys().next().value!);
    }
    return awaitWithAbort(pending, options.signal);
  };

  return {
    catalog,
    describe: (ctx, object, signal) => {
      throwIfAborted(signal);
      const reader = memoizedSchemaReader(createSchemaReader(ctx.connection), stateOf(ctx.username).memo);
      return awaitWithAbort(reader.describe(object), signal);
    },
    async withSource(ctx, config, pick, run, signal) {
      const attempt = async () => run(pick(await catalog(ctx, config, { signal })));
      try {
        return await attempt();
      } catch (error) {
        const code = errorCodeOf(error);
        if (!code || !DRIFT_CODES.has(code)) throw error;
        orgs.delete(ctx.username);
        return attempt();
      }
    },
    clear: () => orgs.clear()
  };
}
