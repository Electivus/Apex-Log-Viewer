import type { LogLevels } from './types';

function normalizeLevel(level: string | undefined): string | undefined {
  const l = (level || '').toUpperCase().trim();
  const allowed = ['FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE'];
  return allowed.includes(l) ? l : undefined;
}

// Parse a line like:
//   "64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;DB,INFO;SYSTEM,DEBUG;..."
export function parseDefaultLogLevels(headLines: string[]): LogLevels | undefined {
  const first = headLines.find(l => /\bAPEX_CODE\b.*[,;]/.test(l));
  if (!first) return undefined;
  const map: LogLevels = {};
  // Take the substring starting at the first category to avoid leading version numbers
  const start = first.indexOf('APEX_');
  const payload = start >= 0 ? first.slice(start) : first;
  for (const part of payload.split(';')) {
    const m = part.match(/([A-Z_]+)\s*,\s*([A-Z]+)/);
    if (m) {
      const [, key, lvl] = m as unknown as [string, string, string];
      const norm = normalizeLevel(lvl);
      if (norm) (map as Record<string, string>)[key] = norm;
    }
  }
  return Object.keys(map).length ? map : undefined;
}

