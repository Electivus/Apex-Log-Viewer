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
/** `events`: a platform event whose rows come from the local event store. */
export type CustomLogSourceShape = 'transactions' | 'entries' | 'events';

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
  | 'metadataQueryRefused' // this user cannot run the EntityDefinition/FieldDefinition query; no fallback is tried
  | 'notQueryable' // a record mapping names an object SOQL cannot read, such as a platform event
  | 'notAnEvent'; // an `event` mapping names an object that is not a platform event

/** A mapped JSON payload: the qualified field and the team's default columns from the mapping. */
export type CustomLogPayloadInfo = { field: string; columns: string[] };

/**
 * One source as `sources` reports it. Every state carries every field, so a consumer reads one
 * shape: a source that is not `ready` has no hidden fields, no unmapped levels, every capability
 * `false` and an empty `payload`, because nothing about it was resolved.
 */
export type CustomLogSourceInfo = {
  id: string;
  label: string;
  /** `config` also when a project source replaces a built-in by reusing its id. */
  origin: CustomLogSourceOrigin;
  shape: CustomLogSourceShape;
  /** Namespace prefix applied to the definition, without `__`. Present only for `nebula-managed`. */
  namespace?: string;
  /** Qualified object API names the source reads. For a `notInstalled` built-in, the names that were looked for. */
  objects: CustomLogSourceObjects;
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
  /** Present for an `events` source whose store root is known, whatever its state. */
  store?: CustomLogStoreInfo;
} & CustomLogSourceState;

/** The objects of a record source (`transactions`, `entries`) or the platform event of an `events` source. */
export type CustomLogSourceObjects = { transaction?: string; entry: string } | { event: string };

/**
 * Event row and entry ids: opaque tokens `e-<9 base36>-<10 base36>-<32 hex>` (55 characters). Two
 * event ids of one source compare in list order: the larger string is newer. Pass them back to
 * `get --log-id` and `entry --entry-id` as is. No part of the id is a Salesforce replay id.
 */
export const CUSTOM_LOG_EVENT_ID_PATTERN = /^e-[0-9a-z]{9}-[0-9a-z]{10}-[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------------------------
// the local event store, as every event result reports it

/**
 * One stretch of time the store cannot vouch for. Times are event `CreatedDate`s. Salesforce never
 * says whether anything was published in the stretch, so every gap means "may be missing".
 */
export type CustomLogStoreGap = {
  /**
   * `cursorRejected`: Salesforce rejected the stored position (older than it keeps, or from before a
   * stream reset), so capture replayed what was still retained. `retentionElapsed`: the stored position
   * was older than the retention window; Salesforce accepted it, which does not prove the events in
   * between were still there. `orgChanged`: the username now names another org (sandbox refresh).
   */
  reason: 'cursorRejected' | 'retentionElapsed' | 'orgChanged';
  /** The newest event stored before the gap. Absent when the store held none. */
  after?: string;
  /** The first event stored after the gap. Absent while the gap is open: nothing newer than `after` has arrived yet. */
  before?: string;
  detectedAt: string;
};

/**
 * What the local history of one event object covers. Every event source reports it, in `sources`,
 * `list`, `get` and `capture`, so an agent knows what a search over it can and cannot find.
 * `notCaptured`: no position was ever stored for this org and object; `list` returns an empty page,
 * never an error, and the panel offers the first-use choice.
 */
export type CustomLogStoreInfo =
  | {
      state: 'notCaptured';
      /** Absolute directory of this event object's files: `<root>/apexlogs/orgs/<safe-org>/events/<Object__e>`. */
      eventsRoot: string;
      retentionDays: number;
    }
  | {
      state: 'captured';
      /** Search it with `rg --no-ignore -g '*.ndjson'`: the store ignores itself (`events/.gitignore` holds `*`), and ripgrep honors that file, so plain `rg` finds nothing. Lines hold every delivered field. */
      eventsRoot: string;
      /** `CreatedDate` of the oldest and newest stored events. Absent when every stored event was purged. */
      oldest?: string;
      newest?: string;
      /** When a capture last confirmed the stored position: a stored batch, or the clean end of a run that reached `live`. */
      lastCaptureAt: string;
      sizeBytes: number;
      /** Days of history core keeps (`eventRetentionDays`). */
      retentionDays: number;
      gaps: CustomLogStoreGap[];
    };

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
  /** Present only when exactly one implicit candidate is ready: the source `list` uses when none is given. An event source never counts, because capturing spends the org's delivery allocation. */
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
export type CustomLogTextFormat = 'json' | 'text';
export { customLogTextFormat } from './textFormat.js';

export type CustomLogLongValue =
  | {
      state: 'value';
      value: string;
      /** `json` when the value parses as a JSON object or array (`customLogTextFormat`). Picks the editor language. */
      format: CustomLogTextFormat;
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
 * Characters a row or entry cell keeps: `title`, the text roles and `extra` strings are cut here,
 * because a column may map a long text field (131072 characters). Long text stays whole only in
 * an `entry` message and in the long values (`details`, `rawPayload`, `logPayload`).
 */
export const CUSTOM_LOG_CELL_CHARS = 255;

/**
 * One row of the list. For a `transactions` source it is a header record; for an `entries`
 * source it is one entry record, and opening it shows every entry with the same transaction id.
 * Rows are ordered by `CreatedDate DESC, Id DESC`, which is never null. Strings are cut at
 * `CUSTOM_LOG_CELL_CHARS`.
 */
export type CustomLogRow = {
  id: string;
  /** ISO-8601. The mapped header `startTime` or entry `time`, or the record's CreatedDate when that value is empty. */
  time: string;
  /** Header `name` (for example `Log-000739`), or the start of the entry message. */
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
  /** Present for an `events` source. */
  store?: CustomLogStoreInfo;
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

/** Strings other than `message` are cut at `CUSTOM_LOG_CELL_CHARS`. */
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

/**
 * Page sizes: `list` pages rows and `get` pages entries. A `limit` out of range is clamped; none takes the default.
 * `drainMs` bounds a drain's `CustomLogCaptureParams.maxDurationMs`; one out of range is rejected.
 */
export const CUSTOM_LOG_LIMITS = {
  list: { default: 50, max: 200 },
  entries: { default: 200, max: 2000 },
  drainMs: { default: 120_000, max: 3_600_000 }
} as const;

/** Link to the Apex debug log of the same request (`ApexLog.RequestIdentifier` = mapped `requestId`). */
export type CustomLogApexLogLink =
  | { state: 'linked'; logId: string; startTime?: string; logLength?: number }
  /** The user can read ApexLog, and none matches this request: no trace flag was active, or Salesforce already deleted it. */
  | { state: 'notFound' }
  /**
   * `noAccess`: the user cannot read ApexLog in this org (no object access, or the API is off), so absence
   * says nothing about the request. `offline`: an `events` source read without an org connection, so the
   * lookup was not attempted.
   */
  | { state: 'unavailable'; reason: 'noAccess' | 'offline' }
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
  /** Present for an `events` source. */
  store?: CustomLogStoreInfo;
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

// ---------------------------------------------------------------------------------------------
// capture

/**
 * What a run does when the store has no usable position for this org (never captured, or the
 * username now names another org). `retained` replays everything Salesforce still keeps; `new`
 * starts with events published from now on; `none` does not subscribe and resolves with outcome
 * `needsInitial` after preparing the store (describe snapshot, allowance).
 */
export type CustomLogCaptureInitial = 'retained' | 'new' | 'none';

export type CustomLogCaptureParams = {
  targetOrg?: string;
  projectDir: string | undefined;
  /** Required: an event source is never chosen implicitly, because capturing spends the org's delivery allocation. */
  source: string;
  /**
   * false (CLI default): stop once the stream has been quiet for 10 s after at least one event
   * (or, when none arrived, after the first-event wait: 15 s for `new` or a cursor younger than one
   * hour, else `maxDurationMs` itself, because first-byte latency grows with the backlog, so a drain
   * that hears nothing from `retained` or an older cursor lasts the whole bound and still ends `quiet`),
   * at the delivery budget, or at `maxDurationMs` while events keep arriving (`timeLimit`). true: run
   * until the signal aborts.
   */
  follow: boolean;
  /**
   * Only used when the store has no usable position (see `CustomLogCaptureInitial`). Default `retained`.
   * The panel passes `none` when it starts on its own, so the first, largest replay of an org always
   * follows a click; an explicit `capture` command is that consent already.
   */
  initial?: CustomLogCaptureInitial;
  /** Drain bound. Default 120 000, at most 3 600 000. Ignored with `follow`. */
  maxDurationMs?: number;
  /** Rows in updates are decoded through `source` and kept only when they match this filter. */
  filter?: Pick<CustomLogFilter, 'minLevel' | 'user'>;
  payloadFields?: string[];
};

export type CustomLogCaptureState =
  | { state: 'connecting' }
  /** Another process (a VS Code window or an `sf` run) holds this event object's capture lease. Rows it stores still arrive here. */
  | { state: 'standby'; holder: { surface: 'vscode' | 'cli'; pid: number; host: string; since: string } }
  /** Subscribed; receiving what Salesforce retained since the stored position (or the retained window). */
  | { state: 'catchingUp'; from: 'position' | 'retained' | 'new' }
  /**
   * `quiet`: inferred, CometD has no end-of-backlog marker; the stream was silent for 10 s
   * after at least one event, or for the first-event wait after the acknowledgement. `signal`: the
   * transport reported the end of the backlog (Pub/Sub keepalive, later).
   */
  | { state: 'live'; basis: 'quiet' | 'signal' }
  | { state: 'reconnecting'; attempt: number; cause: 'transport' | 'auth' | 'overflow' }
  | { state: 'stopped'; outcome: CustomLogCaptureOutcome }
  | { state: 'failed'; code: CustomLogErrorCode; message: string };

/**
 * `quiet`: a drain ended because the stream went quiet, including one whose first-event wait ran to
 * `maxDurationMs` without a single event. It is not proof the backlog was complete; an early stop is
 * harmless because the stored position is exact and the next capture resumes after it.
 * `timeLimit`: `maxDurationMs` passed while events were still arriving, or before the transport was up.
 * `budget`: the run spent its delivery budget (see `CustomLogCaptureAllowance.budget`); the next capture resumes.
 * `aborted`: the caller's signal fired. `capturedElsewhere`: a drain found another process holding the
 * capture lease. `needsInitial`: `initial` was `none` and the store has no usable position.
 */
export type CustomLogCaptureOutcome =
  'quiet' | 'timeLimit' | 'budget' | 'aborted' | 'capturedElsewhere' | 'needsInitial';

/**
 * `DailyDeliveredPlatformEvents` from `/limits`, read once when a run prepares (also for `needsInitial`),
 * shared by every subscriber of the org. `budget` is about what this run will spend: half of `remaining`,
 * or 5 000 when `/limits` could not be read (then `remaining` and `max` are absent). The check runs
 * between flushes, so a run can exceed it by one server response.
 */
export type CustomLogCaptureAllowance = { remaining?: number; max?: number; budget: number };

/** One update per durable write or state change. `rows` were stored before this update was sent. */
export type CustomLogCaptureUpdate = {
  capture: CustomLogCaptureState;
  store: CustomLogStoreInfo;
  /** Decoded through `params.source`, filtered by `params.filter`, trimmed by `params.payloadFields`; same DTO as `list` rows. */
  rows: CustomLogRow[];
  /** Paths seen in this update's rows, like a `list` page's. */
  payloadFields: CustomLogPayloadField[];
  allowance?: CustomLogCaptureAllowance;
};

export type CustomLogCaptureResult = {
  source: CustomLogSourceRef;
  outcome: CustomLogCaptureOutcome;
  /** Events Salesforce delivered to this run, duplicates included: the allocation this run spent. */
  delivered: number;
  /** New events this run stored: duplicates inside the run and re-deliveries of events the store already held are excluded. */
  stored: number;
  /** Gaps this run created. An open gap found at start is not repeated here; `store.gaps` lists every gap. */
  newGaps: CustomLogStoreGap[];
  store: CustomLogStoreInfo;
};

/** `AlvError.code` values this namespace throws, in addition to `INVALID_ARGUMENT` and `ABORTED`. */
export type CustomLogErrorCode =
  | 'CUSTOM_LOG_NO_SOURCE' // no implicit candidate and none requested; the message names the ready event sources and `--source` when the catalog holds any
  | 'CUSTOM_LOG_SOURCE_REQUIRED' // several sources are ready and none was requested; the message lists their ids
  | 'CUSTOM_LOG_SOURCE_NOT_FOUND' // unknown id, or no ready source owns the record id's key prefix
  | 'CUSTOM_LOG_SOURCE_UNAVAILABLE' // the requested source is notInstalled/unavailable; message carries the reason
  | 'CUSTOM_LOG_RECORD_NOT_FOUND' // the id or transaction id is not visible to this user
  | 'CUSTOM_LOG_AMBIGUOUS_TRANSACTION' // several headers carry the requested transaction id; the message lists their ids
  | 'CUSTOM_LOG_UNSUPPORTED_FILTER' // e.g. minLevel on a source with no level mapping, or a transaction id it cannot filter
  | 'CUSTOM_LOG_INVALID_CURSOR' // malformed, or produced for another org, source mapping, query or window
  | 'CUSTOM_LOG_STORE_UNAVAILABLE' // the event store cannot be used: no directory, a newer format, an unreadable lease or checkpoint, a symlinked directory, or a failed write (the message names the file)
  | 'CUSTOM_LOG_NOT_EVENT_SOURCE' // `capture` named a record source
  | 'CUSTOM_LOG_DELIVERY_LIMIT' // `403::Organization total events daily limit exceeded`; capture resumes from the stored position once the rolling 24 h usage drops
  | 'CUSTOM_LOG_CLIENT_LIMIT' // `403::Organization concurrent user limit exceeded` (20 CometD clients on Developer Edition)
  | 'CUSTOM_LOG_SUBSCRIBE_FORBIDDEN' // `403::Restricted channel`: the user lacks Read on the platform event
  | 'CUSTOM_LOG_CAPTURE_FAILED'; // capture stopped for a reason with no finer code: auth rebuilds exhausted, a second rejected cursor in one run, or an unclassified transport failure; the message names the cause
