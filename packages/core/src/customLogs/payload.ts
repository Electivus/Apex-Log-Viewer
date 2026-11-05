/**
 * Decoding long text at the boundary, once: payload views for list and entry rows, the per-page
 * path summary, and long values for `entry`. Pure. Query decoders call these; nothing above core
 * parses a payload again.
 *
 * SOQL cannot filter or sort long text (measured), so JSON columns, their filters and their sorts
 * run over loaded rows only. These functions produce what that UI and `jq` need: flat dot paths
 * with scalar leaves. A page decodes every row, summarizes, then trims to `payloadFields`, so the
 * summary always describes whole payloads.
 *
 * `leaves()` is the only code that knows the path grammar, so a role path and a column path
 * cannot disagree about `metrics[0].name`.
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
 * One row's payload, decoded once. `view` is the flattened, capped and cut view the row shows;
 * `picked` holds the whole values at the role paths, uncut and found past the path cap; `text`
 * is the long value `entry` returns as `rawPayload`, and `compact` the one-line JSON a title
 * falls back to. Both are built on demand.
 */
export type PayloadDoc = {
  readonly view: CustomLogPayloadView;
  readonly picked: ReadonlyMap<string, CustomLogScalar>;
  readonly text: () => CustomLogLongValue;
  /** The parsed document as compact JSON; undefined when the doc is not parsed or will not serialize. */
  readonly compact: () => string | undefined;
};

const NONE: ReadonlySet<string> = new Set();
const NOTHING_PICKED: ReadonlyMap<string, CustomLogScalar> = new Map();
const noCompact = (): undefined => undefined;

/** The doc of a field describe hides: the view and the text say `hidden`, nothing is picked. */
export const HIDDEN_DOC: PayloadDoc = {
  view: { state: 'hidden' },
  picked: NOTHING_PICKED,
  text: () => ({ state: 'hidden' }),
  compact: noCompact
};

/** `JSON.stringify` refuses nesting `JSON.parse` accepts (measured at 10 000 levels): then there is no text. */
function stringify(value: object, indent: number | undefined): string | undefined {
  try {
    return JSON.stringify(value, null, indent);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * Flatten a parsed container depth-first in document order: keys joined with `.`, array items as
 * `[i]`, scalar leaves only (empty objects and arrays yield no path). Keep the first
 * `CUSTOM_LOG_PAYLOAD_LIMITS.paths` leaves and count the rest in `droppedPaths`; cut strings at
 * `valueChars` and list their paths in `cutValues`. The same pass picks the whole value at every
 * `pick` path, whatever its position.
 *
 * Keys that contain `.` or `[` make ambiguous paths. They are rare in log payloads and are not escaped.
 */
function docOfContainer(container: object, pick: ReadonlySet<string>, text: () => CustomLogLongValue): PayloadDoc {
  const values = new Map<string, CustomLogScalar>();
  const picked = new Map<string, CustomLogScalar>();
  const cutValues: string[] = [];
  let droppedPaths = 0;
  for (const [path, value] of leaves(container)) {
    if (pick.has(path)) picked.set(path, value);
    if (values.size >= CUSTOM_LOG_PAYLOAD_LIMITS.paths) {
      droppedPaths++;
    } else if (typeof value === 'string' && value.length > CUSTOM_LOG_PAYLOAD_LIMITS.valueChars) {
      values.set(path, value.slice(0, CUSTOM_LOG_PAYLOAD_LIMITS.valueChars));
      cutValues.push(path);
    } else {
      values.set(path, value);
    }
  }
  return {
    view: { state: 'parsed', values: Object.fromEntries(values), droppedPaths, cutValues },
    picked,
    text,
    compact: () => stringify(container, undefined)
  };
}

/**
 * The doc of one payload cell.
 *
 * - Null or blank → `empty`. A field describe hides never reaches here: the caller answers `HIDDEN_DOC`.
 * - Trimmed text not starting with `{` or `[` → `text`. Starts with one but `JSON.parse` throws →
 *   `invalid`. A parsed scalar → `text`.
 * - Object or array → `docOfContainer`.
 *
 * `text()` is the field's own text either way.
 */
export function docOfText(raw: unknown, pick: ReadonlySet<string>): PayloadDoc {
  const text = () => toLongValue(raw);
  if (isBlank(raw)) return { view: { state: 'empty' }, picked: NOTHING_PICKED, text, compact: noCompact };
  if (typeof raw !== 'string' || !startsLikeJson(raw)) {
    return { view: { state: 'text' }, picked: NOTHING_PICKED, text, compact: noCompact };
  }
  const container = parseJsonContainer(raw);
  if (!container) return { view: { state: 'invalid' }, picked: NOTHING_PICKED, text, compact: noCompact };
  return docOfContainer(container, pick, text);
}

/** The view alone, as a row shows it. `decodePayload(raw)` is `docOfText(raw, NONE).view`. */
export function decodePayload(raw: unknown): CustomLogPayloadView {
  return docOfText(raw, NONE).view;
}

/**
 * The doc of one element of a JSON array: an object or array is parsed, null is empty, a scalar is
 * text. `text()` pretty-prints the element as JSON; when it will not serialize, it answers the
 * whole field's long value (`fieldText`) instead.
 */
export function docOfElement(
  element: unknown,
  pick: ReadonlySet<string>,
  fieldText: () => CustomLogLongValue
): PayloadDoc {
  if (element === null || element === undefined) {
    return { view: { state: 'empty' }, picked: NOTHING_PICKED, text: () => ({ state: 'empty' }), compact: noCompact };
  }
  if (typeof element === 'object') {
    return docOfContainer(element, pick, () => {
      const value = stringify(element, 2);
      return value === undefined ? fieldText() : { state: 'value', value, format: 'json' };
    });
  }
  const value =
    typeof element === 'string'
      ? element
      : typeof element === 'number' || typeof element === 'boolean'
        ? String(element)
        : '';
  return {
    view: { state: 'text' },
    picked: NOTHING_PICKED,
    text: () => ({ state: 'value', value, format: 'text' }),
    compact: noCompact
  };
}

/**
 * What one field of an `entries` payload contributes. `blank` contributes no row; `elements` one row
 * per element of the JSON array, in array order, whatever each element is; `whole` one row, the
 * field itself, for anything else (text, invalid JSON, a JSON object or scalar).
 */
export type SlotReading =
  | { readonly kind: 'blank' }
  | { readonly kind: 'elements'; readonly docs: readonly PayloadDoc[] }
  | { readonly kind: 'whole'; readonly doc: PayloadDoc };

export function readEntrySlot(raw: unknown, pick: ReadonlySet<string>): SlotReading {
  if (isBlank(raw)) return { kind: 'blank' };
  const container = typeof raw === 'string' && startsLikeJson(raw) ? parseJsonContainer(raw) : undefined;
  if (!Array.isArray(container)) return { kind: 'whole', doc: docOfText(raw, pick) };
  const fieldText = () => toLongValue(raw);
  return { kind: 'elements', docs: container.map(element => docOfElement(element, pick, fieldText)) };
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
export function toLongValue(raw: unknown, options: { truncated?: boolean } = {}): CustomLogLongValue {
  if (isBlank(raw)) return { state: 'empty' };
  const value = typeof raw === 'string' ? raw : String(raw);
  return {
    state: 'value',
    value,
    format: customLogTextFormat(value),
    ...(options.truncated === undefined ? {} : { truncated: options.truncated })
  };
}
