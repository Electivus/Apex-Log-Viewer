import type {
  CustomLogPayloadColumnsView,
  CustomLogPayloadField,
  CustomLogPayloadType,
  CustomLogPayloadView,
  CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import type { FilterClause } from './filterGrammar';

/** Anything the list or the detail viewer shows per row: only the payload matters here. */
export type PayloadRow = { payload?: CustomLogPayloadView };

export type PayloadFieldType = CustomLogPayloadType | 'mixed';

export type DiscoveredField = {
  /** Array indexes grouped: `tags[0]` and `tags[1]` are one `tags[]`. */
  path: string;
  types: CustomLogPayloadType[];
  type: PayloadFieldType;
  /** Loaded rows that carry the path. For a grouped array path, the largest count of any index. */
  rows: number;
  /** Percent of loaded rows, 0 to 100. */
  share: number;
};

const ARRAY_INDEX_PATTERN = /\[\d+\]/g;

export function normalizePayloadPath(path: string): string {
  return path.replace(ARRAY_INDEX_PATTERN, '[]');
}

function fieldType(types: readonly CustomLogPayloadType[]): PayloadFieldType {
  const present = types.filter(type => type !== 'null');
  if (present.length === 0) {
    return 'null';
  }
  return present.length === 1 ? present[0]! : 'mixed';
}

/**
 * The paths a user can pick as columns or filters, from the page summaries the host merged.
 * Most loaded rows first, then alphabetical.
 */
export function discoverPayloadFields(
  fields: readonly CustomLogPayloadField[],
  loadedRowCount: number
): DiscoveredField[] {
  const grouped = new Map<string, { types: CustomLogPayloadType[]; rows: number }>();
  for (const field of fields) {
    const path = normalizePayloadPath(field.path);
    const known = grouped.get(path);
    if (!known) {
      grouped.set(path, { types: [...field.types], rows: field.rows });
      continue;
    }
    for (const type of field.types) {
      if (!known.types.includes(type)) {
        known.types.push(type);
      }
    }
    known.rows = Math.max(known.rows, field.rows);
  }
  return [...grouped.entries()]
    .map(([path, { types, rows }]) => ({
      path,
      types,
      type: fieldType(types),
      rows,
      share:
        loadedRowCount > 0 ? Math.min(100, Math.max(rows > 0 ? 1 : 0, Math.round((100 * rows) / loadedRowCount))) : 0
    }))
    .sort((a, b) => b.rows - a.rows || a.path.localeCompare(b.path));
}

// A parsed payload's values are decoded once in core and never change, so the grouped view is memoized on the object.
const groupedValuesCache = new WeakMap<object, Map<string, CustomLogScalar[]>>();

function groupedValues(values: Record<string, CustomLogScalar>): Map<string, CustomLogScalar[]> {
  const cached = groupedValuesCache.get(values);
  if (cached) {
    return cached;
  }
  const grouped = new Map<string, CustomLogScalar[]>();
  for (const [key, value] of Object.entries(values)) {
    const path = normalizePayloadPath(key);
    const list = grouped.get(path);
    if (list) {
      list.push(value);
    } else {
      grouped.set(path, [value]);
    }
  }
  groupedValuesCache.set(values, grouped);
  return grouped;
}

/**
 * Every value a row has at `path`. `tags[]` reads all elements, `tags[1]` just that one.
 * A payload that did not parse has no values.
 */
export function payloadValues(payload: CustomLogPayloadView | undefined, path: string): CustomLogScalar[] {
  if (payload?.state !== 'parsed') {
    return [];
  }
  if (path.includes('[]')) {
    return groupedValues(payload.values).get(path) ?? [];
  }
  return Object.hasOwn(payload.values, path) ? [payload.values[path]!] : [];
}

const NUMERIC_PATTERN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isNumeric(text: string): boolean {
  return NUMERIC_PATTERN.test(text.trim());
}

function equalsValue(value: CustomLogScalar, text: string): boolean {
  if (typeof value === 'number') {
    return isNumeric(text) && value === Number(text);
  }
  if (value === null) {
    return text.toLowerCase() === 'null';
  }
  if (typeof value === 'boolean') {
    return String(value) === text.toLowerCase();
  }
  return value === text;
}

function orderedAgainst(value: CustomLogScalar, text: string, op: '>' | '>=' | '<' | '<='): boolean {
  let left: number | string;
  let right: number | string;
  if (isNumeric(text)) {
    if (typeof value === 'number') {
      left = value;
    } else if (typeof value === 'string' && isNumeric(value)) {
      left = Number(value);
    } else {
      return false;
    }
    right = Number(text);
  } else {
    left = String(value);
    right = text;
  }
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
}

/**
 * Whether a row's payload satisfies one condition. A row whose payload did not parse (invalid,
 * plain text, empty or hidden) never matches, so a JSON filter skips it instead of guessing.
 */
export function payloadMatches(payload: CustomLogPayloadView | undefined, condition: FilterClause): boolean {
  if (payload?.state !== 'parsed') {
    return false;
  }
  const values = payloadValues(payload, condition.field);
  const text = condition.value ?? '';
  switch (condition.op) {
    case 'exists':
      return values.length > 0;
    case '=':
      return values.some(value => equalsValue(value, text));
    case '!=':
      return !values.some(value => equalsValue(value, text));
    case 'contains':
      return values.some(value => String(value).toLowerCase().includes(text.toLowerCase()));
    case '>':
    case '>=':
    case '<':
    case '<=':
      return values.some(value => orderedAgainst(value, text, condition.op as '>' | '>=' | '<' | '<='));
  }
}

export function filterLoadedRows<T extends PayloadRow>(rows: readonly T[], conditions: readonly FilterClause[]): T[] {
  if (conditions.length === 0) {
    return [...rows];
  }
  return rows.filter(row => conditions.every(condition => payloadMatches(row.payload, condition)));
}

function compareScalars(a: CustomLogScalar, b: CustomLogScalar): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Orders rows by one value each. A row without a value (undefined or null) goes last in either
 * direction. Numbers compare as numbers, anything else by natural string order, so a column that
 * mixes `502` and `"500"` still sorts sensibly. The sort is stable.
 */
export function sortLoadedRows<T>(
  rows: readonly T[],
  valueOf: (row: T) => CustomLogScalar | undefined,
  dir: 'asc' | 'desc'
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((a, b) => {
      const aMissing = a.value === undefined || a.value === null;
      const bMissing = b.value === undefined || b.value === null;
      if (aMissing || bMissing) {
        return aMissing && bMissing ? a.index - b.index : aMissing ? 1 : -1;
      }
      return compareScalars(a.value!, b.value!) * sign || a.index - b.index;
    })
    .map(entry => entry.row);
}

export type ValueCount = { value: string; count: number };

/** The values a field takes among `rows`, most frequent first. Each row counts a value once. */
export function topValues<T>(
  rows: readonly T[],
  valuesOf: (row: T) => readonly CustomLogScalar[],
  limit: number
): { values: ValueCount[]; distinct: number } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const value of valuesOf(row)) {
      const key = String(value);
      if (!seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const sorted = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { values: sorted.slice(0, limit), distinct: sorted.length };
}

export type PayloadStateCounts = { parsed: number; invalid: number; text: number; empty: number; hidden: number };

export function countPayloadStates(rows: readonly PayloadRow[]): PayloadStateCounts {
  const counts: PayloadStateCounts = { parsed: 0, invalid: 0, text: 0, empty: 0, hidden: 0 };
  for (const row of rows) {
    if (row.payload) {
      counts[row.payload.state] += 1;
    }
  }
  return counts;
}

export type PayloadColumn = { path: string; origin: 'default' | 'added' };

/**
 * The JSON columns to show: the mapping's defaults first (minus the ones this user hid), then the
 * columns this workspace added. A path never appears twice.
 */
export function resolvePayloadColumns(
  view: CustomLogPayloadColumnsView,
  hiddenDefaults: readonly string[]
): PayloadColumn[] {
  const columns: PayloadColumn[] = [];
  const seen = new Set<string>();
  for (const path of view.defaults) {
    if (!seen.has(path)) {
      seen.add(path);
      if (!hiddenDefaults.includes(path)) {
        columns.push({ path, origin: 'default' });
      }
    }
  }
  for (const path of view.added) {
    if (!seen.has(path)) {
      seen.add(path);
      columns.push({ path, origin: 'added' });
    }
  }
  return columns;
}

export type PayloadTreeNode =
  | { kind: 'group'; key: string; children: PayloadTreeNode[] }
  | { kind: 'leaf'; key: string; rawPath: string; path: string; value: CustomLogScalar };

const PATH_SEGMENT_PATTERN = /([^.[\]]+)|\[(\d+)\]/g;

/** Nests a payload's flat dot paths (`customer.id`, `tags[0]`) back into the object they came from. */
export function buildPayloadTree(values: Record<string, CustomLogScalar>): PayloadTreeNode[] {
  const root: PayloadTreeNode[] = [];
  for (const [rawPath, value] of Object.entries(values)) {
    const segments = [...rawPath.matchAll(PATH_SEGMENT_PATTERN)].map(match =>
      match[2] !== undefined ? `[${match[2]}]` : match[1]!
    );
    let level = root;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        level.push({ kind: 'leaf', key: segment, rawPath, path: normalizePayloadPath(rawPath), value });
        return;
      }
      let group = level.find(
        (node): node is Extract<PayloadTreeNode, { kind: 'group' }> => node.kind === 'group' && node.key === segment
      );
      if (!group) {
        group = { kind: 'group', key: segment, children: [] };
        level.push(group);
      }
      level = group.children;
    });
  }
  return root;
}
