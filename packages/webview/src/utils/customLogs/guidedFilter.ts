import { parseCustomLogLevel, parseSinceValue } from '@alv/protocol/customLogsRules';
import type { CustomLogsFilterView } from '@alv/protocol/customLogsTypes';
import {
  FILTER_OPERATORS,
  formatFilterCondition,
  formatFilterField,
  matchOperatorPrefix,
  readFilterField,
  type FilterCondition,
  type FilterFieldKind,
  type FilterOperator,
  type ServerFilterField
} from './filterGrammar';
import {
  payloadValues,
  topValues,
  type DiscoveredField,
  type PayloadFieldType,
  type PayloadRow,
  type ValueCount
} from './payloadRows';

export const SINCE_QUICK_VALUES = ['1h', '24h', '7d'] as const;

export type GuidedField = {
  path: string;
  /** `server` fields change the SOQL and reload from Salesforce; payload paths only narrow loaded rows. */
  kind: FilterFieldKind;
  type?: PayloadFieldType;
  share?: number;
  /** A payload path that is already a column. */
  isColumn?: boolean;
};

export type GuidedItem = { value: string; count?: number };

export type GuidedStage =
  | { stage: 'field'; query: string; items: GuidedField[] }
  | { stage: 'operator'; field: string; kind: FilterFieldKind; items: FilterOperator[] }
  | { stage: 'value'; field: string; kind: FilterFieldKind; op: FilterOperator; items: GuidedItem[] }
  | { stage: 'commit'; field: string; kind: FilterFieldKind; op: FilterOperator };

export type GuidedContext = {
  /** Server fields this source supports, then the discovered payload paths. */
  fields: readonly GuidedField[];
  /** Suggestions for one field's value, already ranked; the caller knows the loaded rows. */
  valuesFor: (field: string, prefix: string, kind: FilterFieldKind) => readonly GuidedItem[];
};

const MAX_FIELD_ITEMS = 8;
const MAX_VALUE_ITEMS = 8;

export function operatorsFor(
  field: string,
  kind: FilterFieldKind,
  type: PayloadFieldType | undefined
): FilterOperator[] {
  if (kind === 'server') {
    return field === 'level' ? ['>='] : ['='];
  }
  switch (type) {
    case 'number':
      return ['=', '!=', '>', '>=', '<', '<=', 'exists'];
    case 'boolean':
      return ['=', '!=', 'exists'];
    case 'string':
      return ['=', '!=', 'contains', 'exists'];
    default:
      return [...FILTER_OPERATORS];
  }
}

/**
 * What the guided input should offer for the text typed so far. The text is read as one
 * condition: a field, then an operator, then a value; the stage follows from how far it got.
 */
export function computeGuidedStage(text: string, context: GuidedContext): GuidedStage {
  const trimmed = text.replace(/^\s+/, '');
  const quoted = /^["']/.test(trimmed) ? readFilterField(trimmed) : undefined;
  const fieldEnd = quoted?.end ?? /^\S*/.exec(trimmed)![0].length;
  const field = quoted?.text ?? trimmed.slice(0, fieldEnd);
  const after = trimmed.slice(fieldEnd);
  const hasSpace = quoted?.closed !== false && /^\s/.test(after);
  const rest = after.replace(/^\s+/, '');

  if (!hasSpace) {
    const needle = field.toLowerCase();
    const items = context.fields
      .filter(candidate => candidate.path.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(b.path.toLowerCase().startsWith(needle)) - Number(a.path.toLowerCase().startsWith(needle)) ||
          Number(a.kind === 'payload') - Number(b.kind === 'payload')
      )
      .slice(0, MAX_FIELD_ITEMS);
    return { stage: 'field', query: field, items };
  }

  // Unquoted, a field the context offers as a server filter is that filter; quoted, it is always a payload path.
  const kind: FilterFieldKind =
    !quoted && context.fields.some(candidate => candidate.kind === 'server' && candidate.path === field)
      ? 'server'
      : 'payload';
  const known = context.fields.find(candidate => candidate.kind === kind && candidate.path === field);
  const matched = matchOperatorPrefix(rest);
  if (!matched || !matched.complete) {
    const prefix = rest.trim().toLowerCase();
    const items = operatorsFor(field, kind, known?.type).filter(op => op.startsWith(prefix));
    return { stage: 'operator', field, kind, items };
  }
  if (matched.op === 'exists') {
    return { stage: 'commit', field, kind, op: matched.op };
  }
  const prefix = rest.slice(matched.op.length).trim().replace(/^["']/, '').replace(/["']$/, '');
  const items = context.valuesFor(field, prefix, kind).slice(0, MAX_VALUE_ITEMS);
  return { stage: 'value', field, kind, op: matched.op, items };
}

/** What accepting a suggestion writes into the input. */
export function acceptGuidedItem(stage: GuidedStage, index: number): { text: string; commit: boolean } | undefined {
  switch (stage.stage) {
    case 'field': {
      const item = stage.items[index];
      return item ? { text: `${formatFilterField(item.path, item.kind)} `, commit: false } : undefined;
    }
    case 'operator': {
      const op = stage.items[index];
      if (!op) {
        return undefined;
      }
      return op === 'exists'
        ? { text: formatFilterCondition({ field: stage.field, op }, stage.kind), commit: true }
        : { text: `${formatFilterField(stage.field, stage.kind)} ${op} `, commit: false };
    }
    case 'value': {
      const item = stage.items[index];
      return item
        ? {
            text: formatFilterCondition({ field: stage.field, op: stage.op, value: item.value }, stage.kind),
            commit: true
          }
        : undefined;
    }
    case 'commit':
      return { text: formatFilterCondition({ field: stage.field, op: stage.op }, stage.kind), commit: true };
  }
}

export type ServerConditionError =
  | { code: 'serverOperator'; field: ServerFilterField; allowed: FilterOperator[]; at: number }
  | { code: 'serverLevel'; at: number }
  | { code: 'serverSince'; at: number }
  | { code: 'serverUnsupported'; field: 'level' | 'user'; at: number }
  | { code: 'serverSource'; at: number };

export type ServerConditionResult =
  | { ok: true; apply: { kind: 'filter'; filter: CustomLogsFilterView } | { kind: 'source'; sourceId: string } }
  | { ok: false; error: ServerConditionError };

export type ServerConditionContext = {
  filter: CustomLogsFilterView;
  capabilities: { levelFilter: boolean; userFilter: boolean };
  sourceIds: readonly string[];
};

/** Turns a typed `level`, `user`, `since` or `source` condition into the server filter it sets, or says what is wrong. */
export function applyServerCondition(
  condition: FilterCondition,
  context: ServerConditionContext
): ServerConditionResult {
  const field = condition.field as ServerFilterField;
  const allowed = operatorsFor(field, 'server', undefined);
  if (!allowed.includes(condition.op)) {
    return { ok: false, error: { code: 'serverOperator', field, allowed, at: condition.at.operator } };
  }
  const value = condition.value ?? '';
  const valueAt = condition.at.value ?? condition.at.operator;
  switch (field) {
    case 'level': {
      if (!context.capabilities.levelFilter) {
        return { ok: false, error: { code: 'serverUnsupported', field: 'level', at: condition.at.field } };
      }
      const level = parseCustomLogLevel(value);
      return level
        ? { ok: true, apply: { kind: 'filter', filter: { ...context.filter, minLevel: level } } }
        : { ok: false, error: { code: 'serverLevel', at: valueAt } };
    }
    case 'user':
      if (!context.capabilities.userFilter) {
        return { ok: false, error: { code: 'serverUnsupported', field: 'user', at: condition.at.field } };
      }
      return { ok: true, apply: { kind: 'filter', filter: { ...context.filter, user: value } } };
    case 'since':
      return parseSinceValue(value)
        ? { ok: true, apply: { kind: 'filter', filter: { ...context.filter, since: value } } }
        : { ok: false, error: { code: 'serverSince', at: valueAt } };
    case 'source':
      return context.sourceIds.includes(value)
        ? { ok: true, apply: { kind: 'source', sourceId: value } }
        : { ok: false, error: { code: 'serverSource', at: valueAt } };
  }
}

const FILTER_KEY = { level: 'minLevel', user: 'user', since: 'since' } as const;

/** The filter with one server chip removed. */
export function clearServerFilter(
  filter: CustomLogsFilterView,
  field: Exclude<ServerFilterField, 'source'>
): CustomLogsFilterView {
  const { [FILTER_KEY[field]]: _removed, ...rest } = filter;
  return rest;
}

export type ServerChip = { field: Exclude<ServerFilterField, 'source'>; op: FilterOperator; value: string };

export function serverChips(filter: CustomLogsFilterView): ServerChip[] {
  const chips: ServerChip[] = [];
  if (filter.minLevel) {
    chips.push({ field: 'level', op: '>=', value: filter.minLevel });
  }
  if (filter.user) {
    chips.push({ field: 'user', op: '=', value: filter.user });
  }
  if (filter.since) {
    chips.push({ field: 'since', op: '=', value: filter.since });
  }
  return chips;
}

export function guidedPayloadFields(fields: readonly DiscoveredField[], columns: ReadonlySet<string>): GuidedField[] {
  return fields.map(field => ({
    path: field.path,
    kind: 'payload',
    type: field.type,
    share: field.share,
    isColumn: columns.has(field.path)
  }));
}

export function valueCountsToItems(values: readonly ValueCount[]): GuidedItem[] {
  return values.map(({ value, count }) => ({ value, count }));
}

export function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLowerCase().includes(prefix.toLowerCase());
}

/** The most common values of a payload path among the items on screen, narrowed by what the user typed. */
export function payloadValueSuggestions(items: readonly PayloadRow[], path: string, prefix: string): GuidedItem[] {
  return valueCountsToItems(topValues(items, item => payloadValues(item.payload, path), 30).values).filter(item =>
    matchesPrefix(item.value, prefix)
  );
}
