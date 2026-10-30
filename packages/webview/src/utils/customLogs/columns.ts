import {
  CUSTOM_LOG_LEVELS,
  type CustomLogColumn,
  type CustomLogRow,
  type CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import {
  payloadValues,
  type DiscoveredField,
  type PayloadColumn,
  type PayloadFieldType,
  type PayloadRow
} from './payloadRows';

/** A grid column of the list or of the entry viewer: only the standard fields differ between them. */
export type DataColumn<Field extends string> =
  | { id: string; kind: 'std'; field: Field; label: string; width: number; flex?: boolean }
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

export type StandardColumnField = 'time' | 'level' | 'title' | 'user' | 'counts';

export type TableColumn = DataColumn<StandardColumnField>;

export type SortState = { columnId: string; dir: 'asc' | 'desc' };

const STANDARD_WIDTH: Record<StandardColumnField, number> = {
  time: 176,
  level: 84,
  title: 280,
  user: 190,
  counts: 140
};

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
export function buildTableColumns({
  labels,
  extra,
  payload,
  discovered,
  hasUser,
  hasCounts
}: BuildColumnsInput): TableColumn[] {
  const standard: StandardColumnField[] = [
    'time',
    'level',
    'title',
    ...(hasUser ? (['user'] as const) : []),
    ...(hasCounts ? (['counts'] as const) : [])
  ];
  const columns: TableColumn[] = standard.map(field => ({
    id: `std:${field}`,
    kind: 'std',
    field,
    label: labels[field],
    width: STANDARD_WIDTH[field],
    ...(field === 'title' ? { flex: true } : {})
  }));
  return appendDataColumns(columns, { extra, extraWidth: 150, payload, discovered });
}

type ColumnItem = PayloadRow & { extra: Readonly<Record<string, CustomLogScalar>> };

/** The source's display columns, then one column per active payload path, after the standard ones. */
export function appendDataColumns<Field extends string>(
  columns: DataColumn<Field>[],
  input: {
    extra: readonly CustomLogColumn[];
    extraWidth: number;
    payload: readonly PayloadColumn[];
    discovered: readonly DiscoveredField[];
  }
): DataColumn<Field>[] {
  for (const column of input.extra) {
    columns.push({
      id: `extra:${column.key}`,
      kind: 'extra',
      key: column.key,
      label: column.label,
      width: input.extraWidth
    });
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

/** The value a column sorts by; `standard` reads the fields only the caller's list has. */
export function dataColumnSortValue<Field extends string>(
  column: DataColumn<Field>,
  item: ColumnItem,
  standard: (field: Field) => CustomLogScalar | undefined
): CustomLogScalar | undefined {
  switch (column.kind) {
    case 'std':
      return standard(column.field);
    case 'extra':
      return item.extra[column.key];
    case 'payload':
      return payloadValues(item.payload, column.path)[0];
  }
}

export function columnSortValue(row: CustomLogRow, column: TableColumn): CustomLogScalar | undefined {
  return dataColumnSortValue(column, row, field => {
    switch (field) {
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
  });
}
