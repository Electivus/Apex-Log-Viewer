/** Questions a call asks of a `SourceCatalog`: which source it reads, and how `sources` reports each one. Pure. */

import type {
  CustomLogColumn,
  CustomLogPayloadInfo,
  CustomLogSourceInfo,
  CustomLogSourceObjects
} from './contracts.js';
import { customLogError } from './errors.js';
import {
  assertNever,
  filterableField,
  headerObject,
  isEventSource,
  listedObject,
  type CatalogEntry,
  type ResolvedEventObject,
  type ResolvedField,
  type ResolvedPayload,
  type ResolvedRecordSource,
  type ResolvedShape,
  type ResolvedSource,
  type SourceCatalog
} from './resolved.js';

/**
 * The sources a call may pick without `--source`: ready record sources only. An event source is
 * never an implicit candidate, because capturing spends the org's delivery allocation.
 */
export function implicitCandidates(catalog: SourceCatalog): ResolvedRecordSource[] {
  const candidates: ResolvedRecordSource[] = [];
  for (const entry of catalog.entries) {
    if (entry.state !== 'ready' || isEventSource(entry.source)) continue;
    candidates.push(entry.source);
  }
  return candidates;
}

/**
 * The CUSTOM_LOG_NO_SOURCE message, for when `implicitCandidates` is empty. An event-only project
 * has a ready event source that no implicit call may pick, so the message then names it and the
 * flag instead of claiming that no source is ready.
 */
export function noSourceMessage(catalog: SourceCatalog): string {
  const eventSourceIds: string[] = [];
  for (const entry of catalog.entries) {
    if (entry.state === 'ready' && isEventSource(entry.source)) eventSourceIds.push(entry.source.id);
  }
  if (eventSourceIds.length === 0) {
    return 'No log source is ready in this org. Run "sf electivus custom-log sources" to see why.';
  }
  return (
    'No log source can be picked without --source in this org: event sources are never picked implicitly. ' +
    `Pass --source <event source> (ready: ${eventSourceIds.join(', ')}), or run "sf electivus custom-log sources" to see why.`
  );
}

/** A full sentence: every `unavailable` message already ends with its period. */
function describeUnavailable(entry: Exclude<CatalogEntry, { state: 'ready' }>): string {
  if (entry.state === 'unavailable') return `${entry.reason}: ${entry.message}`;
  return entry.hint === 'collision' ? 'not installed (a Log__c exists that is not Nebula Logger).' : 'not installed.';
}

/** The error for an id no source answers to, with the ids that exist. */
export function unknownSource(sourceId: string, known: readonly string[]): never {
  throw customLogError(
    'CUSTOM_LOG_SOURCE_NOT_FOUND',
    `Unknown log source "${sourceId}". Known sources: ${known.join(', ') || 'none'}.`
  );
}

function findEntry(catalog: SourceCatalog, sourceId: string): CatalogEntry {
  const entry = catalog.entries.find(item => item.head.id === sourceId);
  return (
    entry ??
    unknownSource(
      sourceId,
      catalog.entries.map(item => item.head.id)
    )
  );
}

/**
 * Explicit id → that source (SOURCE_NOT_FOUND / SOURCE_UNAVAILABLE). None → the only implicit
 * candidate; several → SOURCE_REQUIRED with their ids; none → NO_SOURCE. Never "first wins", so a
 * script that omits `--source` cannot start reading another source when the project adds one.
 */
export function requireSource(catalog: SourceCatalog, sourceId: string | undefined): ResolvedSource {
  if (sourceId !== undefined) {
    const entry = findEntry(catalog, sourceId);
    if (entry.state === 'ready') return entry.source;
    throw customLogError(
      'CUSTOM_LOG_SOURCE_UNAVAILABLE',
      `Log source "${sourceId}" is not available: ${describeUnavailable(entry)}`
    );
  }
  const candidates = implicitCandidates(catalog);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) throw customLogError('CUSTOM_LOG_NO_SOURCE', noSourceMessage(catalog));
  throw customLogError(
    'CUSTOM_LOG_SOURCE_REQUIRED',
    `Several log sources are ready (${candidates.map(source => source.id).join(', ')}). Pass one with --source.`
  );
}

/** `requireSource` for the SOQL path: an event source holds no records to query. */
export function requireRecordSource(catalog: SourceCatalog, sourceId: string | undefined): ResolvedRecordSource {
  const source = requireSource(catalog, sourceId);
  if (isEventSource(source)) {
    throw customLogError(
      'CUSTOM_LOG_SOURCE_UNAVAILABLE',
      `Log source "${source.id}" holds platform events, which SOQL cannot read.`
    );
  }
  return source;
}

function prefixOf(recordId: string): string {
  return recordId.slice(0, 3);
}

function levelOwning(source: ResolvedRecordSource, prefix: string): 'transaction' | 'entry' | undefined {
  const { shape } = source;
  switch (shape.kind) {
    case 'transactions':
      if (shape.transaction.keyPrefix === prefix) return 'transaction';
      return shape.entry.keyPrefix === prefix ? 'entry' : undefined;
    case 'entries':
      return shape.entry.keyPrefix === prefix ? 'entry' : undefined;
    default:
      return assertNever(shape, 'record shape');
  }
}

/**
 * Route a record id to the source that owns it: explicit id must own the prefix; otherwise
 * first implicit candidate in catalog order whose transaction or entry key prefix matches. An
 * event source owns no key prefix, so a record id never belongs to one.
 */
export function requireSourceForRecord(
  catalog: SourceCatalog,
  sourceId: string | undefined,
  recordId: string
): { source: ResolvedRecordSource; level: 'transaction' | 'entry' } {
  const prefix = prefixOf(recordId);
  const candidates = sourceId === undefined ? implicitCandidates(catalog) : [requireSource(catalog, sourceId)];
  for (const source of candidates) {
    if (isEventSource(source)) continue;
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

/** `defaultSourceId` of the `sources` result: the source `requireSource(catalog, undefined)` would pick. */
export function defaultSourceId(catalog: SourceCatalog): string | undefined {
  const candidates = implicitCandidates(catalog);
  return candidates.length === 1 ? candidates[0]!.id : undefined;
}

function payloadInfo(payload: ResolvedPayload | undefined): CustomLogPayloadInfo | undefined {
  return payload?.state === 'readable' ? { field: payload.field.api, columns: [...payload.columns] } : undefined;
}

/** What an event source can filter on and link: a role it maps, since the store filters in memory. */
export function eventCapabilities(event: ResolvedEventObject): CustomLogSourceInfo['capabilities'] {
  return {
    levelFilter: event.roles.level !== undefined || event.roles.levelOrdinal !== undefined,
    userFilter: event.roles.user !== undefined,
    apexLogLink: event.roles.requestId !== undefined
  };
}

type ReadyFacts = Pick<CustomLogSourceInfo, 'capabilities' | 'payload'> & { objects: CustomLogSourceObjects };

function readyFacts(shape: ResolvedShape): ReadyFacts {
  switch (shape.kind) {
    case 'transactions':
    case 'entries': {
      const listed = listedObject(shape);
      const header = headerObject(shape);
      const transactionPayload = payloadInfo(header?.payload);
      const entryPayload = payloadInfo(shape.entry.payload);
      return {
        objects: {
          ...(header ? { transaction: header.object } : {}),
          entry: shape.entry.object
        },
        capabilities: {
          levelFilter: listed.levelPredicate.kind !== 'none',
          userFilter: filterableField(listed.roles.user) !== undefined,
          apexLogLink: listed.roles.requestId !== undefined
        },
        payload: {
          ...(transactionPayload ? { transaction: transactionPayload } : {}),
          ...(entryPayload ? { entry: entryPayload } : {})
        }
      };
    }
    case 'events': {
      const { event } = shape;
      const payload = payloadInfo(event.payload);
      return {
        objects: { event: event.object },
        capabilities: eventCapabilities(event),
        payload: payload ? { entry: payload } : {}
      };
    }
    default:
      return assertNever(shape, 'source shape');
  }
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
  return {
    ...named,
    ...readyFacts(shape),
    hiddenFields: [...hidden],
    unmappedLevels: [...levels.unmapped],
    state: 'ready'
  };
}

export function toColumns(fields: readonly ResolvedField[]): CustomLogColumn[] {
  return fields.map(field => ({ key: field.key, label: field.label }));
}
