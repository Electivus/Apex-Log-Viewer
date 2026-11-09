import {
  CUSTOM_LOG_LEVELS,
  type CustomLogColumn,
  type CustomLogRow,
  type CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import { fillTemplate } from './format';
import {
  payloadValues,
  type DiscoveredField,
  type PayloadColumn,
  type PayloadFieldType,
  type PayloadRow
} from './payloadRows';

type StandardColumn<Field extends string> = {
  id: string;
  kind: 'std';
  field: Field;
  label: string;
  width: number;
  flex?: boolean;
};

/** A field the source's mapping lists under `columns`, read from the row's or the entry's `extra`. */
export type ExtraColumn = { id: string; kind: 'extra'; key: string; label: string; width: number };

export type PayloadDataColumn = {
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

/** A grid column of the list or of the entry viewer: only the standard fields differ between them. */
export type DataColumn<Field extends string> = StandardColumn<Field> | ExtraColumn | PayloadDataColumn;

/** A column of the header an entry row belongs to, read from `row.log.extra` under the key `logColumns` names. */
export type LogColumn = { id: string; kind: 'log'; key: string; label: string; width: number };

export type StandardColumnField = 'time' | 'level' | 'title' | 'origin' | 'user' | 'log';

export type TableColumn = DataColumn<StandardColumnField> | LogColumn;

export type SortState = { columnId: string; dir: 'asc' | 'desc' };

const STANDARD_WIDTH: Record<StandardColumnField, number> = {
  time: 176,
  level: 84,
  title: 280,
  origin: 190,
  user: 190,
  log: 120
};

export type StandardColumnLabels = Record<StandardColumnField, string>;

export type BuildColumnsInput = {
  /** `logField` labels a log column, with `{label}` for the column's own label. */
  labels: StandardColumnLabels & { logField: string };
  /** The source's `columns[]`, in definition order. */
  extra: readonly CustomLogColumn[];
  /** The `logColumns` of the rows' header, in definition order. */
  logColumns: readonly CustomLogColumn[];
  payload: readonly PayloadColumn[];
  discovered: readonly DiscoveredField[];
  hasOrigin: boolean;
  hasUser: boolean;
  hasLog: boolean;
};

/** Fixed columns, the entry's mapped columns, its log's columns, then one column per active payload path. */
export function buildTableColumns({
  labels,
  extra,
  logColumns,
  payload,
  discovered,
  hasOrigin,
  hasUser,
  hasLog
}: BuildColumnsInput): TableColumn[] {
  const standard: StandardColumnField[] = [
    'time',
    'level',
    'title',
    ...(hasOrigin ? (['origin'] as const) : []),
    ...(hasUser ? (['user'] as const) : []),
    ...(hasLog ? (['log'] as const) : [])
  ];
  return [
    ...standard.map((field): TableColumn => ({
      id: `std:${field}`,
      kind: 'std',
      field,
      label: labels[field],
      width: STANDARD_WIDTH[field],
      ...(field === 'title' ? { flex: true } : {})
    })),
    ...extraDataColumns(extra, 150),
    ...logColumns.map((column): LogColumn => ({
      id: `log:${column.key}`,
      kind: 'log',
      key: column.key,
      label: fillTemplate(labels.logField, { label: column.label }),
      width: 150
    })),
    ...payloadDataColumns(payload, discovered)
  ];
}

export function extraDataColumns(extra: readonly CustomLogColumn[], width: number): ExtraColumn[] {
  return extra.map(column => ({
    id: `extra:${column.key}`,
    kind: 'extra',
    key: column.key,
    label: column.label,
    width
  }));
}

export function payloadDataColumns(
  payload: readonly PayloadColumn[],
  discovered: readonly DiscoveredField[]
): PayloadDataColumn[] {
  const byPath = new Map(discovered.map(field => [field.path, field]));
  return payload.map(column => {
    const field = byPath.get(column.path);
    return {
      id: `payload:${column.path}`,
      kind: 'payload',
      path: column.path,
      label: column.path,
      width: 150,
      locked: column.origin === 'default',
      ...(field ? { type: field.type, rows: field.rows } : {})
    };
  });
}

type ColumnItem = PayloadRow & { extra: Readonly<Record<string, CustomLogScalar>> };

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
  if (column.kind === 'log') {
    return row.log?.extra[column.key];
  }
  return dataColumnSortValue(column, row, field => {
    switch (field) {
      case 'time':
        return row.time;
      case 'level':
        return row.level === undefined ? undefined : CUSTOM_LOG_LEVELS.indexOf(row.level);
      case 'title':
        return row.title;
      case 'origin':
        return row.origin;
      case 'user':
        return row.user;
      case 'log':
        return row.log?.title;
    }
  });
}
