/**
 * Rules the Custom Logs layers must apply the same way. Core owns the semantics; these are the
 * protocol-side copies that the host boundary and the webview share, and
 * `customLogsAgreement.test.ts` in the extension fails when one drifts from core.
 */

import { CUSTOM_LOG_LEVELS, type CustomLogLevel } from './customLogsTypes.js';

const SINCE_DURATION = /^([1-9]\d{0,8})([mhd])$/;
const SINCE_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;
const SINCE_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Case-insensitive like core, and returns the canonical upper-case level. */
export function parseCustomLogLevel(value: unknown): CustomLogLevel | undefined {
  return typeof value === 'string' ? CUSTOM_LOG_LEVELS.find(level => level === value.toUpperCase()) : undefined;
}

/**
 * The trimmed `since` text when core accepts it: `30m`, `24h`, `7d`, or an ISO-8601 instant with an
 * explicit offset (a bare date means midnight UTC). A time without an offset is rejected, because
 * core rejects it and the filter would otherwise stick as a failing server filter.
 */
export function parseSinceValue(value: unknown, now: number = Date.now()): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  const duration = SINCE_DURATION.exec(text);
  const instant = duration
    ? now - Number(duration[1]) * SINCE_UNIT_MS[duration[2] as keyof typeof SINCE_UNIT_MS]
    : SINCE_INSTANT.test(text)
      ? Date.parse(text)
      : Number.NaN;
  return Number.isFinite(instant) && !Number.isNaN(new Date(instant).getTime()) ? text : undefined;
}
