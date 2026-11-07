import { formatDuration } from './format';
import type { ParsedLogEntry } from './logViewerParser';

export interface LogFailure {
  message: string;
  lineNumber?: number;
  entryId: number;
  type: string;
}

export interface LogSummary {
  entryPoint?: string;
  username?: string;
  durationMs?: number;
  startedAt?: string;
}

export interface LogHeading {
  title?: string;
  details: string[];
}

const FAILURE_TYPES_BY_PRIORITY = ['FATAL_ERROR', 'EXCEPTION_THROWN'] as const;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const BRACKETED_TOKEN = /^\[.*\]$/;
const SALESFORCE_ID = /^\d[a-zA-Z0-9]{14}(?:[a-zA-Z0-9]{3})?$/;
const EMAIL = /^[^\s@|]+@[^\s@|]+$/;
const STACK_LINE = /\bline (\d+)\b/i;
const CLOCK_TIME = /^\d{1,2}:\d{2}:\d{2}/;

export function findPrimaryFailure(entries: readonly ParsedLogEntry[]): LogFailure | undefined {
  let index = -1;
  for (const type of FAILURE_TYPES_BY_PRIORITY) {
    index = entries.findIndex(entry => entry.type === type);
    if (index >= 0) break;
  }
  if (index < 0) {
    index = entries.findIndex(entry => entry.category === 'error');
  }
  const entry = entries[index];
  if (!entry) {
    return undefined;
  }
  return {
    message: entry.message.trim() || entry.type,
    lineNumber: entry.lineNumber ?? lineFromStackTrace(entries, index),
    entryId: entry.id,
    type: entry.type
  };
}

/** A FATAL_ERROR line carries no `[n]`. Its stack trace follows as lines without a timestamp. */
function lineFromStackTrace(entries: readonly ParsedLogEntry[], index: number): number | undefined {
  for (let next = index + 1; next < entries.length; next++) {
    const entry = entries[next];
    if (!entry || entry.timestamp) {
      return undefined;
    }
    const match = STACK_LINE.exec(entry.message);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export function deriveLogSummary(entries: readonly ParsedLogEntry[]): LogSummary {
  const summary: LogSummary = {};

  const userInfo = entries.find(entry => entry.type === 'USER_INFO');
  const username = userInfo && payloadTokens(userInfo).find(token => EMAIL.test(token));
  if (username) {
    summary.username = username;
  }

  const codeUnit = entries.find(entry => entry.type === 'CODE_UNIT_STARTED');
  const entryPoint = codeUnit && payloadTokens(codeUnit).find(token => !BRACKETED_TOKEN.test(token) && !SALESFORCE_ID.test(token));
  if (entryPoint) {
    summary.entryPoint = entryPoint;
  }

  const durationMs = elapsedSpanMs(entries);
  if (durationMs !== undefined) {
    summary.durationMs = durationMs;
  }

  const first = entries.find(entry => CLOCK_TIME.test(entry.timestamp));
  if (first) {
    summary.startedAt = first.timestamp.replace(/\.\d+$/, '');
  }

  return summary;
}

function payloadTokens(entry: ParsedLogEntry): string[] {
  return entry.raw
    .split('|')
    .slice(2)
    .map(token => token.trim())
    .filter(Boolean);
}

function elapsedSpanMs(entries: readonly ParsedLogEntry[]): number | undefined {
  const elapsed = entries.flatMap(entry => (entry.elapsed === undefined ? [] : [Number(entry.elapsed)]));
  const first = elapsed[0];
  const last = elapsed[elapsed.length - 1];
  if (elapsed.length < 2 || first === undefined || last === undefined || !(last >= first)) {
    return undefined;
  }
  return (last - first) / NANOSECONDS_PER_MILLISECOND;
}

/** The entry point names the log. Without one, the file name does, and the rest stays as detail. */
export function describeLog(summary: LogSummary, fileName: string): LogHeading {
  const title = summary.entryPoint ?? (fileName || undefined);
  const details = [
    summary.username,
    summary.durationMs === undefined ? undefined : formatDuration(summary.durationMs),
    summary.startedAt,
    summary.entryPoint ? fileName : undefined
  ].filter((part): part is string => Boolean(part));
  return { title, details };
}
