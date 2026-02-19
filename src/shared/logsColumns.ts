export type LogsColumnKey =
  | 'user'
  | 'application'
  | 'operation'
  | 'time'
  | 'duration'
  | 'status'
  | 'codeUnit'
  | 'size'
  | 'match';

export type LogsColumnsConfig = {
  order?: LogsColumnKey[];
  visibility?: Partial<Record<LogsColumnKey, boolean>>;
  widths?: Partial<Record<LogsColumnKey, number>>;
};

export type NormalizedLogsColumnsConfig = {
  order: LogsColumnKey[];
  visibility: Record<LogsColumnKey, boolean>;
  widths: Partial<Record<LogsColumnKey, number>>;
};

export const DEFAULT_LOGS_COLUMN_ORDER: LogsColumnKey[] = [
  'user',
  'application',
  'operation',
  'time',
  'duration',
  'status',
  'codeUnit',
  'size',
  'match'
];

export const DEFAULT_LOGS_COLUMNS_CONFIG: NormalizedLogsColumnsConfig = {
  order: DEFAULT_LOGS_COLUMN_ORDER,
  visibility: Object.fromEntries(DEFAULT_LOGS_COLUMN_ORDER.map(key => [key, true])) as Record<LogsColumnKey, boolean>,
  widths: {}
};

const KNOWN_KEYS = new Set<LogsColumnKey>(DEFAULT_LOGS_COLUMN_ORDER);

function isLogsColumnKey(value: unknown): value is LogsColumnKey {
  return typeof value === 'string' && KNOWN_KEYS.has(value as LogsColumnKey);
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function normalizeLogsColumnsConfig(raw: unknown): NormalizedLogsColumnsConfig {
  const input = raw && typeof raw === 'object' ? (raw as LogsColumnsConfig) : {};

  const rawOrder = Array.isArray(input.order) ? input.order : [];
  const filteredOrder = rawOrder.filter(isLogsColumnKey);
  const order = dedupe([...filteredOrder, ...DEFAULT_LOGS_COLUMN_ORDER]);

  const rawVisibility = input.visibility && typeof input.visibility === 'object' ? input.visibility : {};
  const visibility = Object.fromEntries(
    order.map(key => [key, (rawVisibility as any)[key] === false ? false : true])
  ) as Record<LogsColumnKey, boolean>;

  const rawWidths = input.widths && typeof input.widths === 'object' ? input.widths : {};
  const widths: Partial<Record<LogsColumnKey, number>> = {};
  for (const key of order) {
    const v = (rawWidths as any)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      widths[key] = Math.floor(v);
    }
  }

  return { order, visibility, widths };
}

