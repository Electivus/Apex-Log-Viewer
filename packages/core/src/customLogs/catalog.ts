/** Questions a call asks of a `SourceCatalog`: which source it reads, and how `sources` reports each one. Pure. */

import type { CustomLogColumn, CustomLogPayloadInfo, CustomLogSourceInfo } from './contracts.js';
import { customLogError } from './errors.js';
import {
  assertNever,
  filterableField,
  headerObject,
  listedObject,
  type CatalogEntry,
  type ResolvedField,
  type ResolvedPayload,
  type ResolvedSource,
  type SourceCatalog
} from './resolved.js';

function readyEntries(catalog: SourceCatalog): ResolvedSource[] {
  return catalog.entries.flatMap(entry => (entry.state === 'ready' ? [entry.source] : []));
}

function describeUnavailable(entry: Exclude<CatalogEntry, { state: 'ready' }>): string {
  if (entry.state === 'unavailable') return `${entry.reason}: ${entry.message}`;
  return entry.hint === 'collision' ? 'not installed (a Log__c exists that is not Nebula Logger)' : 'not installed';
}

function findEntry(catalog: SourceCatalog, sourceId: string): CatalogEntry {
  const entry = catalog.entries.find(item => item.head.id === sourceId);
  if (!entry) {
    const known = catalog.entries.map(item => item.head.id).join(', ');
    throw customLogError(
      'CUSTOM_LOG_SOURCE_NOT_FOUND',
      `Unknown log source "${sourceId}". Known sources: ${known || 'none'}.`
    );
  }
  return entry;
}

/**
 * Explicit id → that source (SOURCE_NOT_FOUND / SOURCE_UNAVAILABLE). None → the only ready source;
 * several ready → SOURCE_REQUIRED with their ids; none ready → NO_SOURCE. Never "first wins", so a
 * script that omits `--source` cannot start reading another source when the project adds one.
 */
export function requireSource(catalog: SourceCatalog, sourceId: string | undefined): ResolvedSource {
  if (sourceId !== undefined) {
    const entry = findEntry(catalog, sourceId);
    if (entry.state === 'ready') return entry.source;
    throw customLogError(
      'CUSTOM_LOG_SOURCE_UNAVAILABLE',
      `Log source "${sourceId}" is not available: ${describeUnavailable(entry)}.`
    );
  }
  const ready = readyEntries(catalog);
  if (ready.length === 1) return ready[0]!;
  if (ready.length === 0) {
    throw customLogError(
      'CUSTOM_LOG_NO_SOURCE',
      'No log source is ready in this org. Run "sf electivus custom-log sources" to see why.'
    );
  }
  throw customLogError(
    'CUSTOM_LOG_SOURCE_REQUIRED',
    `Several log sources are ready (${ready.map(source => source.id).join(', ')}). Pass one with --source.`
  );
}

function prefixOf(recordId: string): string {
  return recordId.slice(0, 3);
}

function levelOwning(source: ResolvedSource, prefix: string): 'transaction' | 'entry' | undefined {
  const { shape } = source;
  switch (shape.kind) {
    case 'transactions':
      if (shape.transaction.keyPrefix === prefix) return 'transaction';
      return shape.entry.keyPrefix === prefix ? 'entry' : undefined;
    case 'entries':
      return shape.entry.keyPrefix === prefix ? 'entry' : undefined;
    default:
      return assertNever(shape, 'source shape');
  }
}

/**
 * Route a record id to the source that owns it: explicit id must own the prefix; otherwise
 * first ready source in catalog order whose transaction or entry key prefix matches.
 */
export function requireSourceForRecord(
  catalog: SourceCatalog,
  sourceId: string | undefined,
  recordId: string
): { source: ResolvedSource; level: 'transaction' | 'entry' } {
  const prefix = prefixOf(recordId);
  const candidates = sourceId === undefined ? readyEntries(catalog) : [requireSource(catalog, sourceId)];
  for (const source of candidates) {
    const level = levelOwning(source, prefix);
    if (level) return { source, level };
  }
  throw customLogError(
    'CUSTOM_LOG_SOURCE_NOT_FOUND',
    sourceId === undefined
      ? `No ready log source owns record id ${recordId}.`
      : `Record id ${recordId} does not belong to log source "${sourceId}".`
  );
}

/** `defaultSourceId` of the `sources` result: the ready source `requireSource(catalog, undefined)` would pick. */
export function defaultSourceId(catalog: SourceCatalog): string | undefined {
  const ready = readyEntries(catalog);
  return ready.length === 1 ? ready[0]!.id : undefined;
}

function payloadInfo(payload: ResolvedPayload | undefined): CustomLogPayloadInfo | undefined {
  return payload?.state === 'readable' ? { field: payload.field.api, columns: [...payload.columns] } : undefined;
}

/** A source as `sources` reports it. One that is not ready has the ready-only fields empty, as the contract says. */
export function toSourceInfo(entry: CatalogEntry): CustomLogSourceInfo {
  const { head } = entry;
  const named = {
    id: head.id,
    label: head.label,
    origin: head.origin,
    shape: head.shape,
    ...(head.namespace ? { namespace: head.namespace } : {})
  };
  if (entry.state !== 'ready') {
    const { head: _head, ...state } = entry;
    return {
      ...named,
      objects: { ...head.objects },
      hiddenFields: [],
      unmappedLevels: [],
      capabilities: { levelFilter: false, userFilter: false, apexLogLink: false },
      payload: {},
      ...state
    };
  }
  const { shape, hidden, levels } = entry.source;
  const listed = listedObject(shape);
  const header = headerObject(shape);
  const transactionPayload = payloadInfo(header?.payload);
  const entryPayload = payloadInfo(shape.entry.payload);
  return {
    ...named,
    objects: {
      ...(header ? { transaction: header.object } : {}),
      entry: shape.entry.object
    },
    hiddenFields: [...hidden],
    unmappedLevels: [...levels.unmapped],
    capabilities: {
      levelFilter: listed.levelPredicate.kind !== 'none',
      userFilter: filterableField(listed.roles.user) !== undefined,
      apexLogLink: listed.roles.requestId !== undefined
    },
    payload: {
      ...(transactionPayload ? { transaction: transactionPayload } : {}),
      ...(entryPayload ? { entry: entryPayload } : {})
    },
    state: 'ready'
  };
}

export function toColumns(fields: readonly ResolvedField[]): CustomLogColumn[] {
  return fields.map(field => ({ key: field.key, label: field.label }));
}
