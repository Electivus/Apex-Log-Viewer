/**
 * Decoding long text at the boundary, once: payload views for list and entry rows, the per-page
 * path summary, and long values for `entry`. Pure. Query decoders call these; nothing above core
 * parses a payload again.
 *
 * SOQL cannot filter or sort long text (measured), so JSON columns, their filters and their sorts
 * run over loaded rows only. These functions produce what that UI and `jq` need: flat dot paths
 * with scalar leaves. A page decodes every row, summarizes, then trims to `payloadFields`, so the
 * summary always describes whole payloads.
 */

import {
  CUSTOM_LOG_PAYLOAD_LIMITS,
  type CustomLogLongValue,
  type CustomLogPayloadField,
  type CustomLogPayloadType,
  type CustomLogPayloadView,
  type CustomLogScalar
} from './contracts.js';
import { customLogTextFormat, parseJsonContainer, startsLikeJson } from './textFormat.js';

const PAYLOAD_TYPE_ORDER: readonly CustomLogPayloadType[] = ['string', 'number', 'boolean', 'null'];

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim().length === 0);
}

type Frame = { path: string; value: unknown };

/**
 * Scalar leaves of a parsed JSON container in document order, as `[path, value]`. Iterative, so a
 * payload nested thousands of levels deep cannot overflow the stack.
 */
function* leaves(root: object): Generator<[string, CustomLogScalar]> {
  const stack: Frame[] = [{ path: '', value: root }];
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    const { path, value } = frame;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--)
        stack.push({ path: `${path}[${index}]`, value: value[index] });
    } else if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index]!;
        stack.push({ path: path ? `${path}.${key}` : key, value: child });
      }
    } else if (path) {
      yield [path, value === undefined ? null : (value as CustomLogScalar)];
    }
  }
}

/**
 * Decode one payload cell.
 *
 * - FLS-hidden field → `hidden`; null or blank → `empty`.
 * - Trimmed text not starting with `{` or `[` → `text`. Starts with one but `JSON.parse` throws →
 *   `invalid`. A parsed scalar → `text`.
 * - Object or array → flatten depth-first in document order: keys joined with `.`, array items as
 *   `[i]`, scalar leaves only (empty objects and arrays yield no path). Keep the first
 *   `CUSTOM_LOG_PAYLOAD_LIMITS.paths` leaves and count the rest in `droppedPaths`; cut strings at
 *   `valueChars` and list their paths in `cutValues`.
 *
 * Keys that contain `.` or `[` make ambiguous paths. They are rare in log payloads and are not escaped.
 */
export function decodePayload(raw: unknown, options: { hidden: boolean }): CustomLogPayloadView {
  if (options.hidden) return { state: 'hidden' };
  if (isBlank(raw)) return { state: 'empty' };
  if (typeof raw !== 'string' || !startsLikeJson(raw)) return { state: 'text' };
  const container = parseJsonContainer(raw);
  if (!container) return { state: 'invalid' };

  const values = new Map<string, CustomLogScalar>();
  const cutValues: string[] = [];
  let droppedPaths = 0;
  for (const [path, value] of leaves(container)) {
    if (values.size >= CUSTOM_LOG_PAYLOAD_LIMITS.paths) {
      droppedPaths++;
    } else if (typeof value === 'string' && value.length > CUSTOM_LOG_PAYLOAD_LIMITS.valueChars) {
      values.set(path, value.slice(0, CUSTOM_LOG_PAYLOAD_LIMITS.valueChars));
      cutValues.push(path);
    } else {
      values.set(path, value);
    }
  }
  return { state: 'parsed', values: Object.fromEntries(values), droppedPaths, cutValues };
}

function typeOf(value: CustomLogScalar): CustomLogPayloadType {
  return value === null ? 'null' : (typeof value as CustomLogPayloadType);
}

/** Paths seen across one page's parsed views, with the JSON types found at each and how many rows have them, in first-seen order. */
export function summarizePayloadFields(views: readonly CustomLogPayloadView[]): CustomLogPayloadField[] {
  const seen = new Map<string, { types: Set<CustomLogPayloadType>; rows: number }>();
  for (const view of views) {
    if (view.state !== 'parsed') continue;
    for (const [path, value] of Object.entries(view.values)) {
      const field = seen.get(path) ?? { types: new Set(), rows: 0 };
      field.types.add(typeOf(value));
      field.rows++;
      seen.set(path, field);
    }
  }
  return [...seen].map(([path, { types, rows }]) => ({
    path,
    types: PAYLOAD_TYPE_ORDER.filter(type => types.has(type)),
    rows
  }));
}

/** `payloadFields` (CLI `--payload-fields`): keep only these paths in a parsed view's `values`. Other states pass through. */
export function selectPayloadPaths(view: CustomLogPayloadView, keep: ReadonlySet<string>): CustomLogPayloadView {
  if (view.state !== 'parsed') return view;
  return {
    ...view,
    values: Object.fromEntries(Object.entries(view.values).filter(([path]) => keep.has(path))),
    cutValues: view.cutValues.filter(path => keep.has(path))
  };
}

/**
 * A long field read by `entry`. `format` is `json` when the trimmed text parses as an object or
 * array, which picks the editor language when the extension opens it as a text document.
 * `truncated` is the framework flag's value, present only when the detail maps one.
 */
export function toLongValue(raw: unknown, options: { hidden: boolean; truncated?: boolean }): CustomLogLongValue {
  if (options.hidden) return { state: 'hidden' };
  if (isBlank(raw)) return { state: 'empty' };
  const value = typeof raw === 'string' ? raw : String(raw);
  return {
    state: 'value',
    value,
    format: customLogTextFormat(value),
    ...(options.truncated === undefined ? {} : { truncated: options.truncated })
  };
}
