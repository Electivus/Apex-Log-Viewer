/**
 * `--since 24h` for people, ISO for programs. Pure. Core parses `filter.since` and `filter.until`
 * with this at the boundary, so the CLI flag and the extension's quick filters pass the same
 * strings and agree by construction.
 */

import { customLogError } from './errors.js';

const DURATION = /^([1-9]\d{0,8})([mhd])$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * `30m`, `24h`, `7d` (a positive integer plus m, h or d, counted back from `now`) or an ISO-8601
 * instant with an explicit offset (a bare date means midnight UTC). Returns an ISO instant.
 * Throws `INVALID_ARGUMENT` for anything else.
 */
export function parseSinceExpression(input: string, now: Date): string {
  const text = input.trim();
  const duration = DURATION.exec(text);
  const instant = duration
    ? now.getTime() - Number(duration[1]) * UNIT_MS[duration[2] as keyof typeof UNIT_MS]
    : ISO_INSTANT.test(text)
      ? Date.parse(text)
      : Number.NaN;
  if (!Number.isFinite(instant) || Number.isNaN(new Date(instant).getTime())) {
    throw customLogError(
      'INVALID_ARGUMENT',
      `"${input}" is neither a duration (30m, 24h, 7d) nor an ISO-8601 instant with an offset such as 2026-10-29T12:00:00Z.`
    );
  }
  return new Date(instant).toISOString();
}
