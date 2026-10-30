import {
  CUSTOM_LOG_LEVELS,
  type CustomLogEntry,
  type CustomLogLevel,
  type CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import type { FilterClause } from './filterGrammar';
import { filterLoadedRows, payloadValues, type DiscoveredField, type PayloadColumn } from './payloadRows';
import type { SortState } from './columns';

export type EntryFilters = {
  /** Show only these levels. Empty shows every level. */
  levels: ReadonlySet<CustomLogLevel>;
  /** Show only entries that have at least one of these long fields. Empty shows all. */
  details: ReadonlySet<string>;
  text: string;
  /** The logger's own bookkeeping entries stay hidden until asked for. */
  showSystem: boolean;
  payload: readonly FilterClause[];
};

export function filterEntries(entries: readonly CustomLogEntry[], filters: EntryFilters): CustomLogEntry[] {
  const needle = filters.text.trim().toLowerCase();
  const matching = entries.filter(entry => {
    if (entry.system && !filters.showSystem) {
      return false;
    }
    if (filters.levels.size > 0 && (entry.level === undefined || !filters.levels.has(entry.level))) {
      return false;
    }
    if (filters.details.size > 0 && !entry.presentDetails.some(key => filters.details.has(key))) {
      return false;
    }
    if (needle) {
      const haystack = [entry.message, entry.origin, entry.user, entry.exceptionType, entry.rawLevel, entry.recordId];
      if (!haystack.some(value => value?.toLowerCase().includes(needle))) {
        return false;
      }
    }
    return true;
  });
  return filterLoadedRows(matching, filters.payload);
}

/** Levels present in the entries, most severe first. */
export function countLevels(entries: readonly CustomLogEntry[]): Array<{ level: CustomLogLevel; count: number }> {
  const counts = new Map<CustomLogLevel, number>();
  for (const entry of entries) {
    if (entry.level) {
      counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
    }
  }
  return [...CUSTOM_LOG_LEVELS]
    .reverse()
    .filter(level => counts.has(level))
    .map(level => ({ level, count: counts.get(level)! }));
}

/** Long fields that entries flag as present, in first-seen order. */
export function countPresentDetails(entries: readonly CustomLogEntry[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const key of entry.presentDetails) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

export function countSystemEntries(entries: readonly CustomLogEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.system ? 1 : 0), 0);
}

export type EntryColumn =
  | {
      id: string;
      kind: 'std';
      field: 'sequence' | 'time' | 'level' | 'origin' | 'message';
      label: string;
      width: number;
      flex?: boolean;
    }
  | { id: string; kind: 'extra'; key: string; label: string; width: number }
  | {
      id: string;
      kind: 'payload';
      path: string;
      label: string;
      width: number;
      locked: boolean;
      type?: DiscoveredField['type'];
      rows?: number;
    };

export type EntryColumnLabels = Record<'sequence' | 'time' | 'level' | 'origin' | 'message', string>;

export function buildEntryColumns(input: {
  labels: EntryColumnLabels;
  extra: ReadonlyArray<{ key: string; label: string }>;
  payload: readonly PayloadColumn[];
  discovered: readonly DiscoveredField[];
  hasOrigin: boolean;
}): EntryColumn[] {
  const columns: EntryColumn[] = [
    { id: 'std:sequence', kind: 'std', field: 'sequence', label: input.labels.sequence, width: 52 },
    { id: 'std:time', kind: 'std', field: 'time', label: input.labels.time, width: 108 },
    { id: 'std:level', kind: 'std', field: 'level', label: input.labels.level, width: 84 },
    ...(input.hasOrigin
      ? [{ id: 'std:origin', kind: 'std', field: 'origin', label: input.labels.origin, width: 190 } as const]
      : []),
    { id: 'std:message', kind: 'std', field: 'message', label: input.labels.message, width: 360, flex: true }
  ];
  for (const column of input.extra) {
    columns.push({ id: `extra:${column.key}`, kind: 'extra', key: column.key, label: column.label, width: 140 });
  }
  const byPath = new Map(input.discovered.map(field => [field.path, field]));
  for (const column of input.payload) {
    const field = byPath.get(column.path);
    columns.push({
      id: `payload:${column.path}`,
      kind: 'payload',
      path: column.path,
      label: column.path,
      width: 150,
      locked: column.origin === 'default',
      ...(field ? { type: field.type, rows: field.rows } : {})
    });
  }
  return columns;
}

export function entrySortValue(entry: CustomLogEntry, column: EntryColumn): CustomLogScalar | undefined {
  switch (column.kind) {
    case 'std':
      switch (column.field) {
        case 'sequence':
          return entry.sequence;
        case 'time':
          return entry.time;
        case 'level':
          return entry.level === undefined ? undefined : CUSTOM_LOG_LEVELS.indexOf(entry.level);
        case 'origin':
          return entry.origin;
        case 'message':
          return entry.message;
      }
      return undefined;
    case 'extra':
      return entry.extra[column.key];
    case 'payload':
      return payloadValues(entry.payload, column.path)[0];
  }
}

export type { SortState };
