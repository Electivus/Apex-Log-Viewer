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
  const s = value.toFixed(1);
  const trimmed = s.endsWith('.0') ? s.slice(0, -2) : s;
  return `${trimmed} ${unit}`;
}

export function formatDuration(ms: number): string {
  const n = typeof ms === 'number' && isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (n < 1000) {
    return `${n} ms`;
  }
  const seconds = n / 1000;
  const s = seconds.toFixed(1);
  const trimmed = s.endsWith('.0') ? s.slice(0, -2) : s;
  return `${trimmed} s`;
}
