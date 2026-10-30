export const FILTER_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'exists'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Unquoted, these fields name the list's Salesforce filter; a payload key spelled the same is written quoted. */
export const SERVER_FILTER_FIELDS = ['level', 'user', 'since', 'source'] as const;
export type ServerFilterField = (typeof SERVER_FILTER_FIELDS)[number];

export function isServerFilterField(field: string): field is ServerFilterField {
  return (SERVER_FILTER_FIELDS as readonly string[]).includes(field);
}

/** Whether a field names a server filter field or a payload path, which decides how it is written. */
export type FilterFieldKind = 'server' | 'payload';

/** Character offsets into the parsed text, so a caller can point at the token it dislikes. */
export type FilterConditionPositions = { field: number; operator: number; value?: number };

export type FilterCondition = {
  field: string;
  /** A quoted field names a payload path even when it spells a server filter field. */
  quoted: boolean;
  op: FilterOperator;
  /** Absent for `exists`. */
  value?: string;
  at: FilterConditionPositions;
};

/** A condition without its source positions: what a chip stores and what a row is tested against. */
export type FilterClause = Pick<FilterCondition, 'field' | 'op' | 'value'>;

export type FilterParseErrorCode =
  | 'expectedField'
  | 'expectedOperator'
  | 'expectedValue'
  | 'unterminatedString'
  | 'unsupportedOr'
  | 'expectedAnd'
  | 'expectedConditionAfterAnd';

export type FilterParseError = {
  code: FilterParseErrorCode;
  /** 0-based character offset of the offending token (end of input when something is missing). */
  position: number;
  /** The text found at `position`, when there is one: the field that lacks an operator, the stray word. */
  token?: string;
};

export type FilterParseResult = { ok: true; conditions: FilterCondition[] } | { ok: false; error: FilterParseError };

// A bare field runs until a space, a quote or the first character of an operator; any other payload path is quoted.
const BARE_FIELD_PATTERN = /^[^\s"'<>=!]+/;
const BARE_VALUE_PATTERN = /^[^\s"']+/;
// Longest operators first, so `>=` never reads as `>` followed by `=`.
const OPERATORS_BY_LENGTH = [...FILTER_OPERATORS].sort((a, b) => b.length - a.length);

function isWordOperator(op: FilterOperator): boolean {
  return /^[a-z]/.test(op);
}

/** The operator that starts `rest`, and whether it is followed by something that ends it. */
export function matchOperatorPrefix(rest: string): { op: FilterOperator; complete: boolean } | undefined {
  const lower = rest.toLowerCase();
  for (const op of OPERATORS_BY_LENGTH) {
    if (!lower.startsWith(op)) {
      continue;
    }
    const next = rest[op.length];
    if (next === undefined) {
      return { op, complete: false };
    }
    if ((op === '>' || op === '<') && next === '=') {
      continue;
    }
    if (isWordOperator(op) && /\w/.test(next)) {
      continue;
    }
    return { op, complete: true };
  }
  return undefined;
}

/** A token read from the start of some text: its unescaped text, where it ends, and whether its quote closed. */
export type FilterToken = { text: string; end: number; closed: boolean };

/** The single- or double-quoted string at the start of `text`. An unclosed one runs to the end of `text`. */
function readQuoted(text: string): FilterToken {
  const quote = text[0];
  let j = 1;
  let read = '';
  while (j < text.length && text[j] !== quote) {
    if (text[j] === '\\' && j + 1 < text.length) {
      j++;
    }
    read += text[j];
    j++;
  }
  return j < text.length ? { text: read, end: j + 1, closed: true } : { text: read, end: j, closed: false };
}

/** The field at the start of `text`: a bare path, or a quoted one. */
export function readFilterField(text: string): FilterToken | undefined {
  if (text[0] === '"' || text[0] === "'") {
    return readQuoted(text);
  }
  const bare = BARE_FIELD_PATTERN.exec(text)?.[0];
  return bare ? { text: bare, end: bare.length, closed: true } : undefined;
}

/**
 * Parses `field op value [and field op value ...]`. Fields and values are bare words or single/double
 * quoted strings with backslash escapes. Only `and` joins conditions. Blank input is an empty, valid filter.
 */
export function parseFilterExpression(source: string): FilterParseResult {
  let i = 0;
  const conditions: FilterCondition[] = [];
  const skipSpace = () => {
    while (i < source.length && /\s/.test(source[i]!)) {
      i++;
    }
  };
  const fail = (code: FilterParseErrorCode, position: number, token?: string): FilterParseResult => ({
    ok: false,
    error: token === undefined ? { code, position } : { code, position, token }
  });
  const wordAt = (position: number) => /^\S*/.exec(source.slice(position))?.[0] ?? '';

  skipSpace();
  if (i >= source.length) {
    return { ok: true, conditions };
  }

  for (;;) {
    skipSpace();
    const quoted = source[i] === '"' || source[i] === "'";
    const fieldRead = readFilterField(source.slice(i));
    if (fieldRead && !fieldRead.closed) {
      return fail('unterminatedString', i);
    }
    if (!fieldRead?.text) {
      return fail('expectedField', i, wordAt(i) || undefined);
    }
    const field = fieldRead.text;
    const fieldAt = i;
    i += fieldRead.end;
    skipSpace();

    const operatorAt = i;
    const matched = matchOperatorPrefix(source.slice(i));
    if (!matched) {
      return fail('expectedOperator', i, field);
    }
    i += matched.op.length;
    skipSpace();

    let value: string | undefined;
    let valueAt: number | undefined;
    if (matched.op !== 'exists') {
      valueAt = i;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const quoted = readQuoted(source.slice(i));
        if (!quoted.closed) {
          return fail('unterminatedString', i);
        }
        value = quoted.text;
        i += quoted.end;
      } else {
        const bare = BARE_VALUE_PATTERN.exec(source.slice(i));
        if (!bare || /^[<>=!]/.test(bare[0])) {
          return fail('expectedValue', i, bare?.[0]);
        }
        value = bare[0];
        i += bare[0].length;
      }
    }

    conditions.push({
      field,
      quoted,
      op: matched.op,
      ...(value === undefined ? {} : { value }),
      at:
        valueAt === undefined
          ? { field: fieldAt, operator: operatorAt }
          : { field: fieldAt, operator: operatorAt, value: valueAt }
    });

    skipSpace();
    if (i >= source.length) {
      return { ok: true, conditions };
    }
    const keyword = /^(and|or)(?![\w])/i.exec(source.slice(i));
    if (keyword?.[1]?.toLowerCase() === 'and') {
      i += 3;
      skipSpace();
      if (i >= source.length) {
        return fail('expectedConditionAfterAnd', i);
      }
      continue;
    }
    if (keyword) {
      return fail('unsupportedOr', i, keyword[1]);
    }
    return fail('expectedAnd', i, wordAt(i));
  }
}

const BARE_SAFE_FIELD = /^[^\s"'<>=!]+$/;
const BARE_SAFE_VALUE = /^[^\s"'<>=!][^\s"']*$/;

function quoteText(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The server filter field a parsed condition names, or `undefined` when it names a payload path. */
export function serverFieldOf(condition: Pick<FilterCondition, 'field' | 'quoted'>): ServerFilterField | undefined {
  return !condition.quoted && isServerFilterField(condition.field) ? condition.field : undefined;
}

/**
 * The text that parses back to `field` of this kind: a server field bare, a payload path bare when that is
 * unambiguous, else quoted. A payload key spelled like a server filter field is quoted so it stays a payload path.
 */
export function formatFilterField(field: string, kind: FilterFieldKind): string {
  return kind === 'server' || (BARE_SAFE_FIELD.test(field) && !isServerFilterField(field)) ? field : quoteText(field);
}

/** The text that parses back to `value`: bare when that is unambiguous, else quoted. */
export function formatFilterValue(value: string): string {
  return BARE_SAFE_VALUE.test(value) && !/^and$|^or$/i.test(value) ? value : quoteText(value);
}

export function formatFilterCondition(condition: FilterClause, kind: FilterFieldKind): string {
  const field = formatFilterField(condition.field, kind);
  return condition.value === undefined
    ? `${field} ${condition.op}`
    : `${field} ${condition.op} ${formatFilterValue(condition.value)}`;
}

export function filterConditionsEqual(a: FilterClause, b: FilterClause): boolean {
  return a.field === b.field && a.op === b.op && a.value === b.value;
}
