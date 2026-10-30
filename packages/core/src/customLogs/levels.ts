/**
 * Level normalization. Every source maps its raw values onto `CustomLogLevel`, and every
 * level filter is computed from the resolved table, so "what counts as WARN" has one owner.
 */

import { CUSTOM_LOG_LEVELS, type CustomLogLevel } from './contracts.js';

/** Apex `System.LoggingLevel.ordinal()` (measured: NONE 0, INTERNAL 1, FINEST 2 … ERROR 8). */
export const APEX_LEVEL_ORDINALS: Readonly<Record<CustomLogLevel, number>> = {
  FINEST: 2,
  FINER: 3,
  FINE: 4,
  DEBUG: 5,
  INFO: 6,
  WARN: 7,
  ERROR: 8
};

/**
 * Applied to every source before its own `levels`. Covers Apex names, Pharos `WARNING`
 * and the RFLIB-style `TRACE`/`FATAL`. Keys are upper-case; lookup is case-insensitive.
 */
export const DEFAULT_LEVEL_ALIASES: Readonly<Record<string, CustomLogLevel>> = {
  ...Object.fromEntries(CUSTOM_LOG_LEVELS.map(level => [level, level])),
  WARNING: 'WARN',
  FATAL: 'ERROR',
  TRACE: 'FINEST'
};

/** Resolved per source: alias table plus the raw values known from picklist metadata. */
export type LevelTable = {
  /** Upper-cased raw value → level. */
  readonly byRaw: ReadonlyMap<string, CustomLogLevel>;
  /** Raw spellings (original case) at or above each level, for `IN (...)` predicates. */
  readonly rawAtOrAbove: Readonly<Record<CustomLogLevel, readonly string[]>>;
  /** Picklist values no table maps. */
  readonly unmapped: readonly string[];
};

const LEVEL_BY_ORDINAL = new Map(
  (Object.entries(APEX_LEVEL_ORDINALS) as [CustomLogLevel, number][]).map(([level, ordinal]) => [ordinal, level])
);

export function buildLevelTable(
  sourceLevels: Readonly<Record<string, CustomLogLevel>>,
  picklistValues: readonly string[] | undefined
): LevelTable {
  const byRaw = new Map<string, CustomLogLevel>(Object.entries(DEFAULT_LEVEL_ALIASES));
  for (const [raw, level] of Object.entries(sourceLevels)) byRaw.set(raw.toUpperCase(), level);

  const spellings = [...new Set(picklistValues ?? byRaw.keys())];
  const rawAtOrAbove = Object.fromEntries(
    CUSTOM_LOG_LEVELS.map((min, minIndex) => [
      min,
      spellings.filter(spelling => {
        const level = byRaw.get(spelling.toUpperCase());
        return level !== undefined && CUSTOM_LOG_LEVELS.indexOf(level) >= minIndex;
      })
    ])
  ) as Record<CustomLogLevel, string[]>;
  return {
    byRaw,
    rawAtOrAbove,
    unmapped: spellings.filter(spelling => !byRaw.has(spelling.toUpperCase()))
  };
}

/** Ordinal wins when present and in 2..8; otherwise the raw value through the table. */
export function normalizeLevel(
  table: LevelTable,
  raw: unknown,
  ordinal: unknown
): { level?: CustomLogLevel; rawLevel?: string } {
  const rawLevel = typeof raw === 'string' && raw.trim() ? raw : undefined;
  const fromOrdinal = typeof ordinal === 'number' ? levelFromOrdinal(ordinal) : undefined;
  return { level: fromOrdinal ?? (rawLevel ? table.byRaw.get(rawLevel.trim().toUpperCase()) : undefined), rawLevel };
}

export function levelFromOrdinal(ordinal: number): CustomLogLevel | undefined {
  return LEVEL_BY_ORDINAL.get(ordinal);
}

export function parseCustomLogLevel(value: unknown): CustomLogLevel | undefined {
  return typeof value === 'string' && (CUSTOM_LOG_LEVELS as readonly string[]).includes(value.toUpperCase())
    ? (value.toUpperCase() as CustomLogLevel)
    : undefined;
}
