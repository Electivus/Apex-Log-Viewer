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

export function parseLogLines(lines: string[]): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
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
  if (!line.includes('|')) {
    return {
      id: index,
      timestamp: '',
      type: 'INFO',
      message: line,
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
  const timestamp = tsMatch ? tsMatch[1] ?? '' : prefix.trim();
  const elapsed = tsMatch?.[2];
  const type = (parts[1] ?? '').trim() || 'UNKNOWN';
  const category = categorize(type);

  const restParts = parts.slice(2).map(p => p.trim());
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
  const tokens = upper.split(/[^A-Z]+/).filter(Boolean);
  if (
    tokens.some(token =>
      token === 'EXCEPTION' ||
      token === 'ERROR' ||
      token === 'FATAL' ||
      token === 'FAIL' ||
      token === 'FAILED' ||
      token === 'FAILURE' ||
      token === 'FAULT'
    )
  ) {
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
