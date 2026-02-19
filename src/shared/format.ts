function formatNumber(value: number): string {
  const s = value.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function formatBytes(size: number): string {
  const n = typeof size === 'number' && isFinite(size) ? Math.max(0, Math.floor(size)) : 0;
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (n >= GB) {
    return formatUnit(n / GB, 'GB');
  }
  if (n >= MB) {
    return formatUnit(n / MB, 'MB');
  }
  if (n >= KB) {
    return formatUnit(n / KB, 'KB');
  }
  return `${n} B`;
}

function formatUnit(value: number, unit: 'KB' | 'MB' | 'GB'): string {
  return `${formatNumber(value)} ${unit}`;
}

export function formatDuration(ms: number): string {
  const n = typeof ms === 'number' && isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (n < 1000) {
    return `${n} ms`;
  }
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (n < MINUTE) {
    return `${formatNumber(n / SECOND)} s`;
  }
  if (n < HOUR) {
    return `${formatNumber(n / MINUTE)} min`;
  }
  if (n < DAY) {
    return `${formatNumber(n / HOUR)} h`;
  }
  return `${formatNumber(n / DAY)} d`;
}
