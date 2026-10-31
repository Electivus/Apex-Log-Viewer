/**
 * UI-safe DTOs for the Custom Logs surfaces.
 *
 * They mirror `@alv/core/contracts` field for field, because protocol must not depend on core.
 * Drift fails the extension build: `CoreClient` returns these types from core results by plain
 * assignment (no mapping code), so any field core drops or retypes is a compile error there.
 * Long text values never reach a webview: the host opens them as text documents, and the
 * webview gets `CustomLogLongFieldView`, which names a field and its state only.
 */

export const CUSTOM_LOG_LEVELS = ['FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type CustomLogLevel = (typeof CUSTOM_LOG_LEVELS)[number];
export type CustomLogScalar = string | number | boolean | null;

export type CustomLogSourceShape = 'transactions' | 'entries' | 'events';
export type CustomLogSourceRef = { id: string; label: string; shape: CustomLogSourceShape };

export type CustomLogPayloadInfo = { field: string; columns: string[] };

export type CustomLogSourceView = {
  id: string;
  label: string;
  origin: 'builtin' | 'config';
  shape: CustomLogSourceShape;
  namespace?: string;
  hiddenFields: string[];
  capabilities: { levelFilter: boolean; userFilter: boolean; apexLogLink: boolean };
  payload: { transaction?: CustomLogPayloadInfo; entry?: CustomLogPayloadInfo };
  store?: CustomLogStoreView;
} & (
  | { state: 'ready' }
  | { state: 'notInstalled'; hint?: 'collision' }
  | { state: 'unavailable'; reason: string; message: string }
);

export type CustomLogConfigIssueView = { severity: 'error' | 'warning'; pointer: string; message: string };

export type CustomLogColumn = { key: string; label: string };

export type CustomLogPayloadView =
  | { state: 'parsed'; values: Record<string, CustomLogScalar>; droppedPaths: number; cutValues: string[] }
  | { state: 'invalid' }
  | { state: 'text' }
  | { state: 'empty' }
  | { state: 'hidden' };

export type CustomLogPayloadType = 'string' | 'number' | 'boolean' | 'null';
export type CustomLogPayloadField = { path: string; types: CustomLogPayloadType[]; rows: number };

/** The order every list of payload types uses, so the order never depends on which page or function ran last. */
export const PAYLOAD_TYPE_ORDER: readonly CustomLogPayloadType[] = ['string', 'number', 'boolean', 'null'];

export function orderPayloadTypes(types: Iterable<CustomLogPayloadType>): CustomLogPayloadType[] {
  const present = new Set(types);
  return PAYLOAD_TYPE_ORDER.filter(type => present.has(type));
}

/**
 * Merge page summaries: union of types in `PAYLOAD_TYPE_ORDER`, sum of rows, paths in first-seen order. The
 * one merge both the list provider (for its replay snapshot) and the webviews (on `append`) run.
 */
export function mergePayloadFields(
  loaded: readonly CustomLogPayloadField[],
  page: readonly CustomLogPayloadField[]
): CustomLogPayloadField[] {
  const merged = new Map<string, CustomLogPayloadField>();
  for (const field of [...loaded, ...page]) {
    const known = merged.get(field.path);
    if (!known) {
      merged.set(field.path, { path: field.path, types: orderPayloadTypes(field.types), rows: field.rows });
      continue;
    }
    known.types = orderPayloadTypes([...known.types, ...field.types]);
    known.rows += field.rows;
  }
  return [...merged.values()];
}

export type CustomLogRow = {
  id: string;
  time: string;
  title?: string;
  user?: string;
  level?: CustomLogLevel;
  counts?: { entries?: number; errors?: number; warnings?: number };
  transactionId?: string;
  requestId?: string;
  extra: Record<string, CustomLogScalar>;
  payload?: CustomLogPayloadView;
};

export type CustomLogEntry = {
  id: string;
  sequence: number;
  time: string;
  level?: CustomLogLevel;
  rawLevel?: string;
  message: string;
  previewClipped: boolean;
  messageTruncated?: boolean;
  origin?: string;
  user?: string;
  exceptionType?: string;
  recordId?: string;
  system: boolean;
  presentDetails: string[];
  extra: Record<string, CustomLogScalar>;
  payload?: CustomLogPayloadView;
};

/** A long field the host can open as a read-only text document. `key` is `message`, `payload` or a detail key. */
export type CustomLogLongFieldView = {
  key: string;
  label: string;
  state: 'value' | 'empty' | 'hidden' | 'unmapped';
  format?: 'json' | 'text';
  truncated?: boolean;
};

export type CustomLogApexLogLink =
  | { state: 'linked'; logId: string; startTime?: string; logLength?: number }
  | { state: 'notFound' }
  | { state: 'unavailable'; reason: 'noAccess' | 'offline' }
  | { state: 'noRequestId' };

export type CustomLogStoreGapView = {
  reason: 'cursorRejected' | 'retentionElapsed' | 'orgChanged';
  after?: string;
  before?: string;
  detectedAt: string;
};

export type CustomLogStoreView =
  | { state: 'notCaptured'; eventsRoot: string; retentionDays: number }
  | {
      state: 'captured';
      eventsRoot: string;
      oldest?: string;
      newest?: string;
      lastCaptureAt: string;
      sizeBytes: number;
      retentionDays: number;
      gaps: CustomLogStoreGapView[];
    };

/** `needsInitial`: this org was never captured; the strip offers "Load retained events" and "Only new events". */
export type CustomLogCaptureOutcomeView =
  'quiet' | 'timeLimit' | 'budget' | 'aborted' | 'capturedElsewhere' | 'needsInitial';

export type CustomLogCaptureStateView =
  | { state: 'connecting' }
  | { state: 'standby'; holder: { surface: 'vscode' | 'cli'; pid: number; host: string; since: string } }
  | { state: 'catchingUp'; from: 'position' | 'retained' | 'new' }
  /** `quiet` renders a tooltip: inferred from 10 s without events, not a server signal. */
  | { state: 'live'; basis: 'quiet' | 'signal' }
  | { state: 'reconnecting'; attempt: number; cause: 'transport' | 'auth' | 'overflow' }
  | { state: 'stopped'; outcome: CustomLogCaptureOutcomeView }
  /** `code` is a core `CustomLogErrorCode`, kept a plain string like `unavailable.reason`. */
  | { state: 'failed'; code: string; message: string };

export type CustomLogCaptureAllowanceView = { remaining?: number; max?: number; budget: number };

/** What the capture strip renders. `undefined` in the view state means the selected source is not an event source. */
export type CustomLogCaptureView = {
  capture: CustomLogCaptureStateView;
  store: CustomLogStoreView;
  /** False after the user pressed Stop; the provider will not restart capture on its own. */
  wanted: boolean;
  allowance?: CustomLogCaptureAllowanceView;
};

/** Rows a capture stored, already decoded and filtered for this view. */
export type CustomLogLiveRowsView = { rows: CustomLogRow[]; payloadFields: CustomLogPayloadField[] };

/** What the list toolbar can set. Applied server-side by core; `since` takes an ISO instant or `30m`/`24h`/`7d`. */
export type CustomLogsFilterView = { minLevel?: CustomLogLevel; user?: string; since?: string };

/** JSON columns for one source and level: the mapping's defaults plus the ones this workspace added. */
export type CustomLogPayloadColumnsView = { defaults: string[]; added: string[] };

const MAX_PAYLOAD_COLUMNS = 50;
const MAX_PAYLOAD_PATH_LENGTH = 255;
const RECORD_ID_PATTERN = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
/** Must equal core's `CUSTOM_LOG_EVENT_ID_PATTERN`; `customLogsAgreement.test.ts` pins both. */
export const EVENT_ROW_ID_PATTERN = /^e-[0-9a-z]{9}-[0-9a-z]{10}-[0-9a-f]{32}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

declare const rowIdBrand: unique symbol;
/** A record id or an event id, validated by pattern. A host also requires it to be in its current rows. */
export type CustomLogRowId = string & { readonly [rowIdBrand]: 'CustomLogRowId' };

/**
 * A Salesforce record id as 15 or 18 alphanumerics, or an event id (`e-` and 55 characters in all),
 * the only ids a host accepts back from a webview.
 */
export function parseCustomLogRowId(value: unknown): CustomLogRowId | undefined {
  return typeof value === 'string' && (RECORD_ID_PATTERN.test(value) || EVENT_ROW_ID_PATTERN.test(value))
    ? (value as CustomLogRowId)
    : undefined;
}

/**
 * The user-added JSON column paths a webview posts: at most 50, each 1 to 255 characters without
 * control characters. Duplicates collapse, first occurrence wins. Anything malformed rejects the list.
 */
export function parseCustomLogPayloadColumns(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PAYLOAD_COLUMNS) {
    return undefined;
  }
  const paths: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MAX_PAYLOAD_PATH_LENGTH ||
      item.trim() !== item ||
      CONTROL_CHARACTER_PATTERN.test(item)
    ) {
      return undefined;
    }
    if (!paths.includes(item)) {
      paths.push(item);
    }
  }
  return paths;
}
