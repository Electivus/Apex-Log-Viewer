export const FILTER_OPERATORS = ['=', '!=', '>=', '<=', '>', '<', 'contains', 'exists'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Character offsets into the parsed text, so a caller can point at the token it dislikes. */
export type FilterConditionPositions = { field: number; operator: number; value?: number };

export type FilterCondition = {
  field: string;
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

const FIELD_PATTERN = /^[A-Za-z_$][\w$.[\]-]*/;
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

/**
 * Parses `field op value [and field op value ...]`. Values are bare words or single/double quoted
 * strings with backslash escapes. Only `and` joins conditions. Blank input is an empty, valid filter.
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
    const fieldMatch = FIELD_PATTERN.exec(source.slice(i));
    if (!fieldMatch) {
      return fail('expectedField', i, wordAt(i) || undefined);
    }
    const field = fieldMatch[0];
    const fieldAt = i;
    i += field.length;
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
        let j = i + 1;
        let text = '';
        while (j < source.length && source[j] !== quote) {
          if (source[j] === '\\' && j + 1 < source.length) {
            j++;
          }
          text += source[j];
          j++;
        }
        if (j >= source.length) {
          return fail('unterminatedString', i);
        }
        value = text;
        i = j + 1;
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
      op: matched.op,
      ...(value === undefined ? {} : { value }),
      at: valueAt === undefined ? { field: fieldAt, operator: operatorAt } : { field: fieldAt, operator: operatorAt, value: valueAt }
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

const BARE_SAFE_VALUE = /^[^\s"'<>=!][^\s"']*$/;

/** The text that parses back to `value`: bare when that is unambiguous, else quoted. */
export function formatFilterValue(value: string): string {
  if (BARE_SAFE_VALUE.test(value) && !/^and$|^or$/i.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatFilterCondition(condition: FilterClause): string {
  return condition.value === undefined
    ? `${condition.field} ${condition.op}`
    : `${condition.field} ${condition.op} ${formatFilterValue(condition.value)}`;
}

export function filterConditionsEqual(a: FilterClause, b: FilterClause): boolean {
  return a.field === b.field && a.op === b.op && a.value === b.value;
}
