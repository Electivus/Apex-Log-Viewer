import type { CustomLogScalar } from '@alv/protocol/customLogsTypes';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Local `yyyy-MM-dd HH:mm:ss.SSS`, or the text as received when it is not a date. */
export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${day} ${time}`;
}

/** Local `HH:mm:ss.SSS`, for lists that already sit inside one transaction. */
export function formatClock(iso: string): string {
  const formatted = formatLogTime(iso);
  return formatted === iso ? iso : formatted.slice(11);
}

export function formatScalar(value: CustomLogScalar | undefined): string {
  return value === null ? 'null' : value === undefined ? '' : String(value);
}

export type ScalarKind = 'string' | 'number' | 'boolean' | 'null';

export function scalarKind(value: CustomLogScalar): ScalarKind {
  return value === null ? 'null' : (typeof value as Exclude<ScalarKind, 'null'>);
}

export function formatCount(value: number, locale: string): string {
  try {
    return value.toLocaleString(locale || undefined);
  } catch {
    return value.toLocaleString();
  }
}

/** `{count}` style placeholders, the way the other webview messages fill theirs. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
