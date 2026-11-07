import { isErrorEventType } from '@alv/protocol/logErrorSignals';

export type LogCategory = 'debug' | 'soql' | 'dml' | 'code' | 'limit' | 'system' | 'error' | 'other';

export interface ParsedLogEntry {
  id: number;
  timestamp: string;
  elapsed?: string;
  type: string;
  lineNumber?: number;
  message: string;
  details?: string;
  raw: string;
  category: LogCategory;
}

const APEX_EVENT_LINE = /^\d{1,2}:\d{2}:\d{2}\.\d+(?:\s+\(\d+\))?\s*\|/;
const SOURCE_ECHO_PREFIX = 'Execute Anonymous: ';

/** Salesforce writes `|` in log text as `&#124;`. It changes no other character, not even `&`. */
export function decodeLogText(text: string): string {
  return text.replace(/&#124;/g, '|');
}

/** The log does not escape the Apex source that Execute Anonymous echoes. */
export function decodeLogLine(line: string): string {
  return line.startsWith(SOURCE_ECHO_PREFIX) ? line : decodeLogText(line);
}

export function parseLogLines(lines: string[]): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const previousEntry = entries[entries.length - 1];
    if (previousEntry?.category === 'debug' && !APEX_EVENT_LINE.test(raw.trimEnd())) {
      const continuation = raw.trimEnd();
      previousEntry.message = `${previousEntry.message}\n${decodeLogText(continuation)}`;
      previousEntry.raw = `${previousEntry.raw}\n${raw}`;
      continue;
    }
    const entry = parseLogLine(raw, i);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function parseLogLine(raw: string, index: number): ParsedLogEntry | undefined {
  const line = raw.trimEnd();
  if (!line) {
    return undefined;
  }
  if (!APEX_EVENT_LINE.test(line)) {
    return {
      id: index,
      timestamp: '',
      type: 'INFO',
      message: decodeLogLine(line),
      raw,
      category: 'other'
    };
  }

  const parts = line.split('|');
  if (parts.length === 0) {
    return undefined;
  }
  const prefix = parts[0] ?? '';
  const tsMatch = prefix.match(/^(\d{1,2}:\d{2}:\d{2}\.\d+)(?:\s+\((\d+)\))?/);
  const timestamp = tsMatch ? (tsMatch[1] ?? '') : prefix.trim();
  const elapsed = tsMatch?.[2];
  const type = (parts[1] ?? '').trim() || 'UNKNOWN';
  const category = categorize(type);

  const restParts = parts.slice(2).map(p => decodeLogText(p.trim()));
  let tokens = restParts.filter(p => p.length > 0);
  let lineNumber: number | undefined;
  if (tokens.length > 0) {
    const first = tokens[0] ?? '';
    const numMatch = first.match(/^\[(\d+)\]$/);
    if (numMatch) {
      lineNumber = Number(numMatch[1]);
      tokens = tokens.slice(1);
    }
  }

  let details: string | undefined;
  let messageTokens = [...tokens];
  if (category === 'code' && messageTokens.length > 1) {
    details = messageTokens.pop();
  } else if (category === 'soql' && messageTokens.length > 1) {
    const candidate = messageTokens[messageTokens.length - 1] ?? '';
    if (/\bselect\b/i.test(candidate) || /\bfind\b/i.test(candidate) || candidate.length > 60) {
      details = messageTokens.pop();
    }
  } else if (category === 'dml' && messageTokens.length > 1) {
    const candidate = messageTokens[messageTokens.length - 1] ?? '';
    if (/^(insert|update|delete|merge|upsert)/i.test(candidate.trim())) {
      details = messageTokens.pop();
    }
  }

  let message = messageTokens.join(' | ');
  if (!message && details) {
    message = details;
    details = undefined;
  }

  return {
    id: index,
    timestamp,
    elapsed,
    type,
    lineNumber,
    message,
    details,
    raw,
    category
  };
}

function categorize(type: string): LogCategory {
  const upper = type.toUpperCase();
  if (isErrorEventType(type)) {
    return 'error';
  }
  if (upper === 'USER_DEBUG') {
    return 'debug';
  }
  if (upper.startsWith('SOQL')) {
    return 'soql';
  }
  if (upper.startsWith('DML')) {
    return 'dml';
  }
  if (upper.startsWith('CODE_UNIT')) {
    return 'code';
  }
  if (upper.startsWith('LIMIT_USAGE')) {
    return 'limit';
  }
  if (upper.includes('METHOD') || upper.endsWith('ENTRY') || upper.endsWith('EXIT')) {
    return 'system';
  }
  return 'other';
}
