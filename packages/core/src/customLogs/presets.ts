/**
 * Built-in presets: a source written by us in the exact JSON a user would put in
 * `sfdx-project.json`, plus how to detect it with zero config.
 *
 * `definition` is produced by the same `parseSourceDefinition` that reads user config, at module
 * load, so a preset can never use a capability the configured path lacks. A core test validates
 * each `raw` against `schemas/sfdx-project.electivus.schema.json`, which keeps the preset, the
 * parser and the schema in agreement.
 *
 * Nebula ships as two ids, one per distribution: `nebula` (unlocked package or source deploy, no
 * namespace) and `nebula-managed` (`Nebula__`). `--source` therefore names one namespace in every
 * org, and an org with both distributions shows both. Extras, columns and detail keys stay keyed by
 * the unprefixed definition names, so a script reads the same keys from either id. Each also has an
 * event twin, `nebula-events` and `nebula-events-managed`, over `LogEntryEvent__e`.
 *
 * A project source that reuses one of these ids replaces the preset in that project, for example
 * to map `entry.payload` to `Message__c`.
 */

import { parseSourceDefinition, type FieldPath, type SourceDefinition } from './config.js';

export type BuiltinPreset = {
  raw: Readonly<Record<string, unknown>>;
  definition: SourceDefinition;
  /** Applied to every custom name with `qualifyPath`. `''` is "no namespace". */
  namespace: string;
  /**
   * Fields that must exist on the entry object (after qualification) for the objects to count
   * as this framework. An unrelated `Log__c` has the same API name as unlocked Nebula's.
   * Checked against `FieldDefinition`, which lists fields regardless of FLS (measured), so a
   * field hidden from `LoggerEndUser` cannot turn Nebula into a false collision.
   */
  fingerprint: readonly FieldPath[];
};

/**
 * Nebula Logger v4.x: `Log__c` header, master-detail `LogEntry__c`. `EpochTimestamp__c` orders in
 * ms because `Timestamp__c` has second precision. `TransactionEntryNumber__c` orders inside a
 * transaction. The ordinal drives level filters. Roll-ups give list counts without touching
 * entries. `LoggerEndUser` reads every `Has*` flag even where the text itself is hidden
 * (measured), so the UI can say "has a stack trace you cannot read". No payload: a project that
 * wants `Message__c` as JSON replaces the preset id.
 */
const NEBULA_RAW = {
  id: 'nebula',
  label: 'Nebula Logger',
  transaction: {
    object: 'Log__c',
    fields: {
      startTime: 'StartTime__c',
      name: 'Name',
      user: 'LoggedByUsername__c',
      transactionId: 'TransactionId__c',
      requestId: 'RequestId__c',
      entryCount: 'TotalLogEntries__c',
      errorCount: 'TotalERRORLogEntries__c',
      warningCount: 'TotalWARNLogEntries__c',
      maxLevelOrdinal: 'MaxLogEntryLoggingLevelOrdinal__c'
    },
    columns: ['SystemMode__c', 'TransactionScenarioName__c', 'Status__c']
  },
  entry: {
    object: 'LogEntry__c',
    parent: 'Log__c',
    fields: {
      time: 'EpochTimestamp__c',
      order: 'TransactionEntryNumber__c',
      message: 'Message__c',
      messageTruncated: 'MessageTruncated__c',
      level: 'LoggingLevel__c',
      levelOrdinal: 'LoggingLevelOrdinal__c',
      origin: 'OriginLocation__c',
      exceptionType: 'ExceptionType__c',
      recordId: 'RecordId__c'
    },
    columns: ['OriginType__c'],
    details: [
      'ExceptionMessage__c',
      { field: 'ExceptionStackTrace__c', presence: 'HasExceptionStackTrace__c' },
      { field: 'StackTrace__c', presence: 'HasStackTrace__c' },
      { field: 'RecordJson__c', presence: 'HasRecordJson__c', truncated: 'RecordJsonTruncated__c' },
      'HttpRequestEndpointAddress__c',
      { field: 'HttpRequestBody__c', presence: 'HasHttpRequestBody__c', truncated: 'HttpRequestBodyTruncated__c' },
      { field: 'HttpResponseBody__c', presence: 'HasHttpResponseBody__c', truncated: 'HttpResponseBodyTruncated__c' },
      { field: 'RestRequestBody__c', presence: 'HasRestRequestBody__c', truncated: 'RestRequestBodyTruncated__c' },
      { field: 'RestResponseBody__c', presence: 'HasRestResponseBody__c', truncated: 'RestResponseBodyTruncated__c' },
      { field: 'DatabaseResultJson__c', presence: 'HasDatabaseResultJson__c' },
      'Tags__c'
    ],
    systemMessagePrefix: 'Nebula Logger - '
  }
} as const;

const NEBULA_FINGERPRINT = ['Log__c', 'TransactionEntryNumber__c', 'LoggingLevelOrdinal__c', 'EpochTimestamp__c'];

/**
 * Nebula's `LogEntryEvent__e`, the platform event it publishes before (or instead of) storing a
 * `LogEntry__c`. Every field is one the measured describe lists. The event is the entry, so there is
 * no header: transaction context rides on `TransactionId__c`. Platform events have no formula fields,
 * so no detail has a `Has*` presence flag; only the `*Truncated__c` flags exist. A preset is never
 * picked without `--source`, because capturing it spends the org's delivery allocation.
 */
const NEBULA_EVENTS_RAW = {
  id: 'nebula-events',
  label: 'Nebula Logger events',
  event: {
    object: 'LogEntryEvent__e',
    fields: {
      time: 'EpochTimestamp__c',
      order: 'TransactionEntryNumber__c',
      message: 'Message__c',
      messageTruncated: 'MessageTruncated__c',
      level: 'LoggingLevel__c',
      levelOrdinal: 'LoggingLevelOrdinal__c',
      origin: 'OriginLocation__c',
      user: 'LoggedByUsername__c',
      transactionId: 'TransactionId__c',
      requestId: 'RequestId__c',
      exceptionType: 'ExceptionType__c',
      recordId: 'RecordId__c'
    },
    columns: ['OriginType__c', 'SystemMode__c', 'TransactionScenario__c'],
    details: [
      'ExceptionMessage__c',
      'ExceptionStackTrace__c',
      'StackTrace__c',
      { field: 'RecordJson__c', truncated: 'RecordJsonTruncated__c' },
      'HttpRequestEndpointAddress__c',
      { field: 'HttpRequestBody__c', truncated: 'HttpRequestBodyTruncated__c' },
      { field: 'HttpResponseBody__c', truncated: 'HttpResponseBodyTruncated__c' },
      { field: 'RestRequestBody__c', truncated: 'RestRequestBodyTruncated__c' },
      { field: 'RestResponseBody__c', truncated: 'RestResponseBodyTruncated__c' },
      'DatabaseResultJson__c',
      'Tags__c'
    ],
    systemMessagePrefix: 'Nebula Logger - '
  }
} as const;

const NEBULA_EVENTS_FINGERPRINT = [
  'TransactionId__c',
  'TransactionEntryNumber__c',
  'LoggingLevelOrdinal__c',
  'EpochTimestamp__c'
];

function builtin(
  raw: Readonly<Record<string, unknown>>,
  options: Pick<BuiltinPreset, 'namespace'> & { fingerprint: readonly string[] }
): BuiltinPreset {
  const parsed = parseSourceDefinition(raw, '/builtin');
  if (!parsed.definition)
    throw new Error(`Invalid built-in preset ${String(raw.id)}: ${JSON.stringify(parsed.issues)}`);
  return {
    raw,
    definition: parsed.definition,
    namespace: options.namespace,
    fingerprint: options.fingerprint as readonly FieldPath[]
  };
}

export const NEBULA_PRESET = builtin(NEBULA_RAW, { namespace: '', fingerprint: NEBULA_FINGERPRINT });

export const NEBULA_MANAGED_PRESET = builtin(
  { ...NEBULA_RAW, id: 'nebula-managed', label: 'Nebula Logger (managed)' },
  { namespace: 'Nebula', fingerprint: NEBULA_FINGERPRINT }
);

export const NEBULA_EVENTS_PRESET = builtin(NEBULA_EVENTS_RAW, {
  namespace: '',
  fingerprint: NEBULA_EVENTS_FINGERPRINT
});

export const NEBULA_EVENTS_MANAGED_PRESET = builtin(
  { ...NEBULA_EVENTS_RAW, id: 'nebula-events-managed', label: 'Nebula Logger events (managed)' },
  { namespace: 'Nebula', fingerprint: NEBULA_EVENTS_FINGERPRINT }
);

/** The registry. Supporting another framework is one entry here (one per distribution). */
export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  NEBULA_PRESET,
  NEBULA_MANAGED_PRESET,
  NEBULA_EVENTS_PRESET,
  NEBULA_EVENTS_MANAGED_PRESET
];

const CUSTOM_SUFFIXES: ReadonlySet<string> = new Set(['c', 'r', 'e', 'mdt', 'x', 'b']);

/**
 * Prefix every custom segment (`__c`, `__r`) of a path with `ns__`, unless the segment is
 * already namespaced (two `__` separators). Standard names are left alone. Pure.
 *
 *   qualifyPath('Log__c', 'Nebula')               → 'Nebula__Log__c'
 *   qualifyPath('LoggedBy__r.Username', 'Nebula') → 'Nebula__LoggedBy__r.Username'
 *   qualifyPath('pharos__Log__c', 'Nebula')       → 'pharos__Log__c'
 *   qualifyPath('Name', 'Nebula')                 → 'Name'
 *   qualifyPath('Log__c', '')                     → 'Log__c'
 */
export function qualifyPath(path: string, namespace: string): string {
  if (!namespace) return path;
  return path
    .split('.')
    .map(segment => {
      const [, suffix, ...rest] = segment.split('__');
      return suffix !== undefined && rest.length === 0 && CUSTOM_SUFFIXES.has(suffix)
        ? `${namespace}__${segment}`
        : segment;
    })
    .join('.');
}
