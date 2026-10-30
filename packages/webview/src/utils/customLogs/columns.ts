import { CUSTOM_LOG_LEVELS, type CustomLogColumn, type CustomLogRow, type CustomLogScalar } from '@alv/protocol/customLogsTypes';
import { payloadValues, type DiscoveredField, type PayloadColumn, type PayloadFieldType } from './payloadRows';

export type StandardColumnField = 'time' | 'level' | 'title' | 'user' | 'counts';

export type TableColumn =
  | { id: string; kind: 'std'; field: StandardColumnField; label: string; width: number; flex?: boolean }
  | { id: string; kind: 'extra'; key: string; label: string; width: number }
  | {
      id: string;
      kind: 'payload';
      path: string;
      label: string;
      width: number;
      /** Pinned by the project mapping: it can be hidden for this user, never removed. */
      locked: boolean;
      type?: PayloadFieldType;
      rows?: number;
    };

export type SortState = { columnId: string; dir: 'asc' | 'desc' };

const STANDARD_WIDTH: Record<StandardColumnField, number> = { time: 176, level: 84, title: 280, user: 190, counts: 140 };

export type StandardColumnLabels = Record<StandardColumnField, string>;

export type BuildColumnsInput = {
  labels: StandardColumnLabels;
  /** The source's `columns[]`, in definition order. */
  extra: readonly CustomLogColumn[];
  payload: readonly PayloadColumn[];
  discovered: readonly DiscoveredField[];
  hasUser: boolean;
  hasCounts: boolean;
};

/** Fixed columns first, then the source's display columns, then one column per active payload path. */
export function buildTableColumns({ labels, extra, payload, discovered, hasUser, hasCounts }: BuildColumnsInput): TableColumn[] {
  const standard: StandardColumnField[] = ['time', 'level', 'title', ...(hasUser ? (['user'] as const) : []), ...(hasCounts ? (['counts'] as const) : [])];
  const columns: TableColumn[] = standard.map(field => ({
    id: `std:${field}`,
    kind: 'std',
    field,
    label: labels[field],
    width: STANDARD_WIDTH[field],
    ...(field === 'title' ? { flex: true } : {})
  }));
  for (const column of extra) {
    columns.push({ id: `extra:${column.key}`, kind: 'extra', key: column.key, label: column.label, width: 150 });
  }
  const byPath = new Map(discovered.map(field => [field.path, field]));
  for (const column of payload) {
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

/** The value a column sorts by. */
export function columnSortValue(row: CustomLogRow, column: TableColumn): CustomLogScalar | undefined {
  switch (column.kind) {
    case 'std':
      switch (column.field) {
        case 'time':
          return row.time;
        case 'level':
          return row.level === undefined ? undefined : CUSTOM_LOG_LEVELS.indexOf(row.level);
        case 'title':
          return row.title;
        case 'user':
          return row.user;
        case 'counts':
          return row.counts?.entries;
      }
      return undefined;
    case 'extra':
      return row.extra[column.key];
    case 'payload':
      return payloadValues(row.payload, column.path)[0];
  }
}
