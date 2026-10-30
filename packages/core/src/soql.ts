import { AlvError } from './errors.js';

const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

// SOQL string literals understand these escapes; any other C0 control character has no spelling.
const SOQL_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f'
};
const SOQL_LIKE_ESCAPES: Readonly<Record<string, string>> = { ...SOQL_ESCAPES, '%': '\\%', _: '\\_' };
const UNSPELLABLE_CONTROL = /[\u0000-\u0007\u000b\u000e-\u001f]/;

function escapeWith(value: string, escapes: Readonly<Record<string, string>>): string {
  const text = String(value || '');
  const control = UNSPELLABLE_CONTROL.exec(text);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(4, '0');
    throw new AlvError(
      'INVALID_ARGUMENT',
      `A SOQL literal cannot contain the control character U+${code.toUpperCase()}.`
    );
  }
  return text.replace(/[\\'"\n\r\t\b\f%_]/g, char => escapes[char] ?? char);
}

/** The body of a single-quoted SOQL string literal. Rejects control characters SOQL cannot spell. */
export function escapeSoqlLiteral(value: string): string {
  return escapeWith(value, SOQL_ESCAPES);
}

/** Like `escapeSoqlLiteral`, plus the `%` and `_` wildcards, for the body of a `LIKE` pattern. */
export function escapeSoqlLikeLiteral(value: string): string {
  return escapeWith(value, SOQL_LIKE_ESCAPES);
}

export function isSalesforceId(value: unknown): value is string {
  return typeof value === 'string' && SALESFORCE_ID_REGEX.test(value);
}

/** ISO-8601 instant for a SOQL datetime literal, or undefined when unparseable. */
export function normalizeSoqlDateTimeLiteral(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}
