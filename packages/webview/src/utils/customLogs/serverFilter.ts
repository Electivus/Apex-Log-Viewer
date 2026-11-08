import { parseCustomLogLevel } from '@alv/protocol/customLogsRules';
import { CUSTOM_LOG_LEVELS, type CustomLogRow, type CustomLogsFilterView } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate } from './format';

export const SINCE_QUICK_VALUES = ['1h', '24h', '7d'] as const;

export type FilterKey = keyof CustomLogsFilterView;

export type FilterOption = { value: string; label: string };

/** One select of the Filters menu. `value` '' is `anyLabel`: the key is not set. */
export type FilterMenuField = {
  key: FilterKey;
  label: string;
  anyLabel: string;
  value: string;
  options: FilterOption[];
};

export type FilterMenuModel = {
  fields: FilterMenuField[];
  /** Keys the server filter sets: the badge on the Filters button, and whether Clear has anything to do. */
  activeCount: number;
  note: string;
};

type FilterMenuInput = {
  filter: CustomLogsFilterView;
  capabilities: { levelFilter: boolean; userFilter: boolean };
  rows: readonly CustomLogRow[];
  /** The source reads a local event store, so a change re-reads it instead of querying Salesforce. */
  stored: boolean;
  t: CustomLogsMessages['filters'];
};

/** The value set now leads its options, so a user or a time typed elsewhere is never shown as Any. */
function withCurrent(current: string | undefined, options: FilterOption[]): FilterOption[] {
  return current && !options.some(option => option.value === current)
    ? [{ value: current, label: current }, ...options]
    : options;
}

export function filterMenuModel({ filter, capabilities, rows, stored, t }: FilterMenuInput): FilterMenuModel {
  const fields: FilterMenuField[] = [];
  if (capabilities.levelFilter) {
    fields.push({
      key: 'minLevel',
      label: t.level,
      anyLabel: t.levelAny,
      value: filter.minLevel ?? '',
      options: [...CUSTOM_LOG_LEVELS].reverse().map(level => ({
        value: level,
        label: fillTemplate(t.levelAtLeast, { level })
      }))
    });
  }
  if (capabilities.userFilter) {
    const users = [...new Set(rows.flatMap(row => (row.user ? [row.user] : [])))].sort((a, b) => a.localeCompare(b));
    fields.push({
      key: 'user',
      label: t.user,
      anyLabel: t.userAny,
      value: filter.user ?? '',
      options: withCurrent(
        filter.user,
        users.map(user => ({ value: user, label: user }))
      )
    });
  }
  fields.push({
    key: 'since',
    label: t.time,
    anyLabel: t.timeAny,
    value: filter.since ?? '',
    options: withCurrent(
      filter.since,
      SINCE_QUICK_VALUES.map(value => ({ value, label: t.timeQuick[value] }))
    )
  });
  return {
    fields,
    activeCount: [filter.minLevel, filter.user, filter.since].filter(Boolean).length,
    note: stored ? t.noteStored : t.note
  };
}

/** The complete filter after one select changed; '' clears the key. */
export function withFilter(filter: CustomLogsFilterView, key: FilterKey, value: string): CustomLogsFilterView {
  const { [key]: _previous, ...rest } = filter;
  switch (key) {
    case 'minLevel': {
      const level = parseCustomLogLevel(value);
      return level ? { ...rest, minLevel: level } : rest;
    }
    case 'user':
    case 'since':
      return value ? { ...rest, [key]: value } : rest;
  }
}
