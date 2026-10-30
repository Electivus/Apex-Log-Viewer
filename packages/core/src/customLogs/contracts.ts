/**
 * Public params and results of `core.customLog.*`.
 *
 * Re-exported by `packages/core/src/contracts.ts` with one line
 * (`export * from './customLogs/contracts.js';`), so `@alv/core/contracts` stays the
 * single public type entry and the CLI JSON shape is defined exactly once.
 *
 * Every result here is a CLI JSON contract (one-way door). Evolution rule: add optional
 * fields only. Ids and values are plain JSON strings; internal code works with the
 * branded forms in `config.ts` and `queries.ts` after parsing.
 */

/** Canonical levels in ascending severity. Apex names, because the users are Apex developers. */
export const CUSTOM_LOG_LEVELS = ['FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type CustomLogLevel = (typeof CUSTOM_LOG_LEVELS)[number];

export type CustomLogScalar = string | number | boolean | null;

/**
 * Compile error when `T` has a top-level `body` key: `AlvCommand.printResult` writes such a
 * result's `body` raw instead of printing JSON. Every `custom-log` command declares
 * `AlvCommand<PrintsAsJson<Result>>`.
 */
export type PrintsAsJson<T> = 'body' extends keyof T ? never : T;

/** Shared scope of every org-bound custom-log call. */
export type CustomLogScope = {
  targetOrg?: string;
  /**
   * A directory inside the Salesforce project. Core walks up to `sfdx-project.json` and reads
   * `plugins.electivus.customLogs` fresh on every call. `undefined` means "no project": only
   * built-in presets apply. The key is required so a caller cannot forget it and silently lose
   * the project's mapping (the `workspaceRoot` → `os.tmpdir()` fallback is the lesson).
   */
  projectDir: string | undefined;
  /**
   * Source id. Omitted: `list` and `get` by transaction id use the only ready source
   * (CUSTOM_LOG_SOURCE_REQUIRED when several are ready); `get` by log id and `entry` match the
   * record id's key prefix.
   */
  source?: string;
};

// ---------------------------------------------------------------------------------------------
// sources

export type CustomLogSourcesParams = Omit<CustomLogScope, 'source'> & {
  /** Drop this org's cached detection and describe answers, misses included, before resolving. */
  refresh?: boolean;
};

export type CustomLogSourceOrigin = 'builtin' | 'config';
export type CustomLogSourceShape = 'transactions' | 'entries';

export type CustomLogSourceState =
  | { state: 'ready' }
  /** Built-in preset whose objects are absent. `collision`: a `Log__c` exists but fails the Nebula fingerprint. */
  | { state: 'notInstalled'; hint?: 'collision' }
  | { state: 'unavailable'; reason: CustomLogUnavailableReason; message: string };

export type CustomLogUnavailableReason =
  | 'objectNotFound' // configured object absent from EntityDefinition
  | 'objectNotReadable' // EntityDefinition lists the object, describe answers NOT_FOUND for this user
  | 'requiredFieldMissing' // a required role field is absent or hidden by FLS
  | 'fieldTypeMismatch' // a role, detail flag or payload points at a field of an incompatible type
  | 'metadataQueryRefused'; // this user cannot run the EntityDefinition/FieldDefinition query; no fallback is tried

/** A mapped JSON payload: the qualified field and the team's default columns from the mapping. */
export type CustomLogPayloadInfo = { field: string; columns: string[] };

export type CustomLogSourceInfo = {
  id: string;
  label: string;
  /** `config` also when a project source replaces a built-in by reusing its id. */
  origin: CustomLogSourceOrigin;
  shape: CustomLogSourceShape;
  /** Namespace prefix applied to the definition, without `__`. Present only for `nebula-managed`. */
  namespace?: string;
  /** Qualified object API names the source reads. For a `notInstalled` built-in, the names that were looked for. */
  objects: { transaction?: string; entry: string };
  /**
   * Definition paths dropped because describe omits them (FLS or absent): `entry.fields.exceptionType`,
   * `entry.details.StackTrace__c`, `entry.details.RecordJson__c.truncated`, `entry.payload`.
   */
  hiddenFields: string[];
  /** Raw level values found in picklist metadata that no level table maps. They never match a level filter. */
  unmappedLevels: string[];
  capabilities: { levelFilter: boolean; userFilter: boolean; apexLogLink: boolean };
  /** Payload mapping per level. Empty object when the source maps none. */
  payload: { transaction?: CustomLogPayloadInfo; entry?: CustomLogPayloadInfo };
} & CustomLogSourceState;

export type CustomLogConfigIssueCode =
  | 'invalidJson'
  | 'notAnObject'
  | 'missingRequired'
  | 'invalidValue'
  | 'unknownKey' // a typo, or a key from a newer version
  | 'duplicateId';

/**
 * The verdict of each issue code. The parser takes `severity` from here, and the JSON schema is
 * tested against it: the schema rejects a fixture exactly when the parser reports an `error`.
 */
export const CUSTOM_LOG_CONFIG_ISSUE_SEVERITY = {
  invalidJson: 'error',
  notAnObject: 'error',
  missingRequired: 'error',
  invalidValue: 'error',
  unknownKey: 'warning',
  duplicateId: 'error'
} as const satisfies Record<CustomLogConfigIssueCode, 'error' | 'warning'>;

export type CustomLogConfigIssue = {
  severity: 'error' | 'warning';
  /** JSON pointer into `sfdx-project.json`, for example `/plugins/electivus/customLogs/sources/0/entry/fields/time`. */
  pointer: string;
  code: CustomLogConfigIssueCode;
  message: string;
};

export type CustomLogSourcesResult = {
  /** Absolute path of the `sfdx-project.json` that was read, when one was found. */
  projectFile?: string;
  /** Present only when exactly one source is ready: the source `list` uses when none is given. */
  defaultSourceId?: string;
  /** Config sources in file order, then the built-ins they do not replace. */
  sources: CustomLogSourceInfo[];
  issues: CustomLogConfigIssue[];
};

// ---------------------------------------------------------------------------------------------
// JSON payloads and long values

/** Per-row bounds of a decoded payload. Leaves beyond `paths` are dropped; strings beyond `valueChars` are cut. */
export const CUSTOM_LOG_PAYLOAD_LIMITS = { paths: 200, valueChars: 500 } as const;

/**
 * A row's mapped payload field, decoded once by core. `values` keys are dot paths with array
 * indexes (`order.lines[0].sku`); only scalar leaves are kept.
 */
export type CustomLogPayloadView =
  | {
      state: 'parsed';
      values: Record<string, CustomLogScalar>;
      /** Scalar leaves past the path cap that `values` omits. Nonzero: open the full payload for the rest. */
      droppedPaths: number;
      /** Paths in `values` whose string was cut at the character cap. */
      cutValues: string[];
    }
  /** Starts like a JSON object or array but does not parse. */
  | { state: 'invalid' }
  /** Plain text, or a JSON scalar: nothing to turn into columns. */
  | { state: 'text' }
  | { state: 'empty' }
  /** FLS hides the payload field from this user. */
  | { state: 'hidden' };

export type CustomLogPayloadType = 'string' | 'number' | 'boolean' | 'null';

/** One payload path seen on a page. The UI merges these across the pages it has loaded. */
export type CustomLogPayloadField = { path: string; types: CustomLogPayloadType[]; rows: number };

/** A long text value read on demand. */
export type CustomLogLongValue =
  | {
      state: 'value';
      value: string;
      /** `json` when the value parses as a JSON object or array. Picks the editor language. */
      format: 'json' | 'text';
      /** The logging framework's own truncation flag (for example `RecordJsonTruncated__c`), when mapped. */
      truncated?: boolean;
    }
  | { state: 'empty' }
  | { state: 'hidden' }
  /** The source maps no field for this value. */
  | { state: 'unmapped' };

// ---------------------------------------------------------------------------------------------
// list

export type CustomLogFilter = {
  /** Keep rows at or above this level: a transaction's worst level, or an entry's level. */
  minLevel?: CustomLogLevel;
  /** Exact username, case-insensitive (SOQL string equality). */
  user?: string;
  /**
   * Inclusive lower and exclusive upper bound: an ISO-8601 instant, or a duration before now
   * (`30m`, `24h`, `7d`). Core resolves a duration on the first page and carries the instant in
   * the cursor, so later pages keep the same window.
   */
  since?: string;
  until?: string;
};

export type CustomLogListParams = CustomLogScope & {
  /** Default 50, clamped to 1..200. */
  limit?: number;
  /** Opaque token from a previous `nextCursor`. Bound to the org, the source mapping and the filter that produced it. */
  cursor?: string;
  filter?: CustomLogFilter;
  /** Keep only these paths in each row's payload `values` (CLI `--payload-fields`). `payloadFields` still lists every path. */
  payloadFields?: string[];
};

export type CustomLogSourceRef = { id: string; label: string; shape: CustomLogSourceShape };

/** Display-only field from `columns`. `key` is the field as written in the definition (unprefixed). */
export type CustomLogColumn = { key: string; label: string };

/**
 * One row of the list. For a `transactions` source it is a header record; for an `entries`
 * source it is one entry record, and opening it shows every entry with the same transaction id.
 * Rows are ordered by `CreatedDate DESC, Id DESC`, which is never null.
 */
export type CustomLogRow = {
  id: string;
  /** ISO-8601. The mapped header `startTime` or entry `time`, or the record's CreatedDate when that value is empty. */
  time: string;
  /** Header `name` (for example `Log-000739`), or the entry message preview. */
  title?: string;
  user?: string;
  /** Worst level of the transaction, or the entry's level. */
  level?: CustomLogLevel;
  counts?: { entries?: number; errors?: number; warnings?: number };
  transactionId?: string;
  requestId?: string;
  extra: Record<string, CustomLogScalar>;
  /** Absent when this level of the source maps no payload. */
  payload?: CustomLogPayloadView;
};

export type CustomLogListResult = {
  source: CustomLogSourceRef;
  columns: CustomLogColumn[];
  rows: CustomLogRow[];
  /** Paths seen in this page's payloads. Empty when the source maps none at this level. */
  payloadFields: CustomLogPayloadField[];
  /** `null` when this was the last page. */
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------------------------
// get

/** One transaction, named by a record id from `list` or by the framework's transaction id. */
export type CustomLogGetParams = CustomLogScope & {
  /** Entries per page. Default 200, clamped to 1..2000. */
  limit?: number;
  cursor?: string;
  minLevel?: CustomLogLevel;
  payloadFields?: string[];
} & (
    | {
        /** Header record id (`transactions`) or any entry id of the transaction (`entries`). */
        logId: string;
        transactionId?: never;
      }
    | {
        /** The mapped `transactionId` value, for example Nebula's `TransactionId__c` UUID. */
        transactionId: string;
        logId?: never;
      }
  );

export type CustomLogEntry = {
  id: string;
  /** Order inside the transaction: the mapped `order` field, else the 1-based position. */
  sequence: number;
  /** ISO-8601 with millisecond precision when the time field carries it. */
  time: string;
  level?: CustomLogLevel;
  /** The stored value, kept for display when it maps to no canonical level. */
  rawLevel?: string;
  /** Capped at `CUSTOM_LOG_MESSAGE_PREVIEW_CHARS` in `get`; complete in `entry`. */
  message: string;
  /** Core cut `message` to the preview cap. Always false in `entry`. */
  previewClipped: boolean;
  /** The logging framework cut the stored message (`messageTruncated` role, Nebula `MessageTruncated__c`). Absent when unmapped. */
  messageTruncated?: boolean;
  origin?: string;
  user?: string;
  exceptionType?: string;
  recordId?: string;
  /** The logger's own bookkeeping (`entry.systemMessagePrefix`). The UI hides these by default. */
  system: boolean;
  /** Detail keys whose `presence` flag is set on this entry, so a list can show a chip without reading the text. */
  presentDetails: string[];
  extra: Record<string, CustomLogScalar>;
  /** Absent when the entry object maps no payload. */
  payload?: CustomLogPayloadView;
};

export const CUSTOM_LOG_MESSAGE_PREVIEW_CHARS = 2000;

/** Link to the Apex debug log of the same request (`ApexLog.RequestIdentifier` = mapped `requestId`). */
export type CustomLogApexLogLink =
  | { state: 'linked'; logId: string; startTime?: string; logLength?: number }
  /** The user can read ApexLog, and none matches this request: no trace flag was active, or Salesforce already deleted it. */
  | { state: 'notFound' }
  /** The user cannot read ApexLog in this org (no object access, or the API is off), so absence says nothing about the request. */
  | { state: 'unavailable'; reason: 'noAccess' }
  /** The source maps no `requestId`, FLS hides it, or this record has no value. */
  | { state: 'noRequestId' };

export type CustomLogGetResult = {
  source: CustomLogSourceRef;
  log: CustomLogRow;
  /** The header's full payload. Present only for a `transactions` source that maps `transaction.payload`. */
  logPayload?: CustomLogLongValue;
  entryColumns: CustomLogColumn[];
  entries: CustomLogEntry[];
  /** Paths seen in this page's entry payloads. */
  payloadFields: CustomLogPayloadField[];
  nextCursor: string | null;
  apexLog: CustomLogApexLogLink;
};

// ---------------------------------------------------------------------------------------------
// entry

export type CustomLogEntryParams = CustomLogScope & { entryId: string };

/** One mapped detail field, in definition order, whatever its state. */
export type CustomLogDetail = { key: string; label: string } & CustomLogLongValue;

export type CustomLogEntryResult = {
  source: CustomLogSourceRef;
  /** The row id to open with `get`: the header id, or this entry's id for an `entries` source. */
  logId: string;
  /** Full message, never clipped by core. */
  entry: CustomLogEntry;
  details: CustomLogDetail[];
  /** The entry's full payload text. */
  rawPayload: CustomLogLongValue;
};

/** `AlvError.code` values this namespace throws, in addition to `INVALID_ARGUMENT` and `ABORTED`. */
export type CustomLogErrorCode =
  | 'CUSTOM_LOG_NO_SOURCE' // no ready source and none requested
  | 'CUSTOM_LOG_SOURCE_REQUIRED' // several sources are ready and none was requested; the message lists their ids
  | 'CUSTOM_LOG_SOURCE_NOT_FOUND' // unknown id, or no ready source owns the record id's key prefix
  | 'CUSTOM_LOG_SOURCE_UNAVAILABLE' // the requested source is notInstalled/unavailable; message carries the reason
  | 'CUSTOM_LOG_RECORD_NOT_FOUND' // the id or transaction id is not visible to this user
  | 'CUSTOM_LOG_AMBIGUOUS_TRANSACTION' // several headers carry the requested transaction id; the message lists their ids
  | 'CUSTOM_LOG_UNSUPPORTED_FILTER' // e.g. minLevel on a source with no level mapping, or a transaction id it cannot filter
  | 'CUSTOM_LOG_INVALID_CURSOR'; // malformed, or produced for another org, source mapping, query or window
