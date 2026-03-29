const ERROR_EVENT_TOKENS = new Set([
  'EXCEPTION',
  'ERROR',
  'FATAL',
  'FAIL',
  'FAILED',
  'FAILURE',
  'FAULT'
]);

export function tokenizeLogEventType(eventType: string): string[] {
  return eventType.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
}

export function isErrorEventType(eventType: string): boolean {
  const tokens = tokenizeLogEventType(eventType);
  return tokens.some(token => ERROR_EVENT_TOKENS.has(token));
}

export function extractLogEventType(line: string): string | undefined {
  if (!line.includes('|')) {
    return undefined;
  }
  const parts = line.split('|');
  if (parts.length < 2) {
    return undefined;
  }
  const eventType = (parts[1] ?? '').trim();
  return eventType || undefined;
}

export function lineHasErrorSignal(line: string): boolean {
  const eventType = extractLogEventType(line);
  if (!eventType) {
    return false;
  }
  return isErrorEventType(eventType);
}
