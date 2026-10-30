import {
  formatFilterCondition,
  parseFilterExpression,
  serverFieldOf,
  type FilterCondition,
  type FilterParseResult
} from '../utils/customLogs/filterGrammar';

function conditionsOf(result: FilterParseResult): Array<Pick<FilterCondition, 'field' | 'op' | 'value'>> {
  if (!result.ok) {
    throw new Error(`expected a valid filter, got ${JSON.stringify(result.error)}`);
  }
  return result.conditions.map(({ field, op, value }) =>
    value === undefined ? { field, op } : { field, op, value }
  ) as Array<Pick<FilterCondition, 'field' | 'op' | 'value'>>;
}

function errorOf(source: string) {
  const result = parseFilterExpression(source);
  if (result.ok) {
    throw new Error(`expected an error for ${JSON.stringify(source)}`);
  }
  return result.error;
}

describe('filter grammar', () => {
  it('reads field, operator and value', () => {
    expect(conditionsOf(parseFilterExpression('http.status >= 500'))).toEqual([
      { field: 'http.status', op: '>=', value: '500' }
    ]);
  });

  it('does not need spaces around symbolic operators', () => {
    expect(conditionsOf(parseFilterExpression('http.status>=500'))).toEqual([
      { field: 'http.status', op: '>=', value: '500' }
    ]);
    expect(conditionsOf(parseFilterExpression('orderId!=ORD-1'))).toEqual([
      { field: 'orderId', op: '!=', value: 'ORD-1' }
    ]);
  });

  it('reads every operator and prefers the longest symbol', () => {
    const operators = ['=', '!=', '>', '>=', '<', '<=', 'contains'] as const;
    for (const op of operators) {
      expect(conditionsOf(parseFilterExpression(`a ${op} 1`))).toEqual([{ field: 'a', op, value: '1' }]);
    }
    expect(conditionsOf(parseFilterExpression('a CONTAINS x'))).toEqual([{ field: 'a', op: 'contains', value: 'x' }]);
  });

  it('reads exists without a value', () => {
    expect(conditionsOf(parseFilterExpression('error.code exists'))).toEqual([{ field: 'error.code', op: 'exists' }]);
    expect(conditionsOf(parseFilterExpression('error.code exists and http.status = 500'))).toEqual([
      { field: 'error.code', op: 'exists' },
      { field: 'http.status', op: '=', value: '500' }
    ]);
  });

  it('reads quoted strings with spaces, the other quote and escapes', () => {
    expect(conditionsOf(parseFilterExpression('message = "Read timed out"'))).toEqual([
      { field: 'message', op: '=', value: 'Read timed out' }
    ]);
    expect(conditionsOf(parseFilterExpression('message = \'say "hi"\''))).toEqual([
      { field: 'message', op: '=', value: 'say "hi"' }
    ]);
    expect(conditionsOf(parseFilterExpression('message = "a \\"quoted\\" word \\\\ done"'))).toEqual([
      { field: 'message', op: '=', value: 'a "quoted" word \\ done' }
    ]);
    expect(conditionsOf(parseFilterExpression('note = ""'))).toEqual([{ field: 'note', op: '=', value: '' }]);
  });

  it('keeps and inside a quoted value from joining conditions', () => {
    expect(conditionsOf(parseFilterExpression('message = "a and b"'))).toEqual([
      { field: 'message', op: '=', value: 'a and b' }
    ]);
  });

  it('reads array paths', () => {
    expect(conditionsOf(parseFilterExpression('tags[] = "vip"'))).toEqual([{ field: 'tags[]', op: '=', value: 'vip' }]);
    expect(conditionsOf(parseFilterExpression('lines[0].sku = SKU-1'))).toEqual([
      { field: 'lines[0].sku', op: '=', value: 'SKU-1' }
    ]);
  });

  it('reads the paths of a root array, grouped or by index', () => {
    expect(conditionsOf(parseFilterExpression('[].status >= 500 and [0][1].x exists'))).toEqual([
      { field: '[].status', op: '>=', value: '500' },
      { field: '[0][1].x', op: 'exists' }
    ]);
    expect(conditionsOf(parseFilterExpression('[]>=1'))).toEqual([{ field: '[]', op: '>=', value: '1' }]);
  });

  it('reads keys that are not identifiers, and quoted fields with spaces or operator characters', () => {
    expect(conditionsOf(parseFilterExpression('pedido.situação = ok and 200.ok = true and @type exists'))).toEqual([
      { field: 'pedido.situação', op: '=', value: 'ok' },
      { field: '200.ok', op: '=', value: 'true' },
      { field: '@type', op: 'exists' }
    ]);
    expect(conditionsOf(parseFilterExpression('"Account Name" = Acme and \'a>=b\' exists'))).toEqual([
      { field: 'Account Name', op: '=', value: 'Acme' },
      { field: 'a>=b', op: 'exists' }
    ]);
  });

  it('joins conditions with and, in any case', () => {
    expect(
      conditionsOf(parseFilterExpression('http.status >= 500 and customer.tier = gold AND durationMs < 100'))
    ).toEqual([
      { field: 'http.status', op: '>=', value: '500' },
      { field: 'customer.tier', op: '=', value: 'gold' },
      { field: 'durationMs', op: '<', value: '100' }
    ]);
  });

  it('treats blank text as an empty filter', () => {
    expect(parseFilterExpression('')).toEqual({ ok: true, conditions: [] });
    expect(parseFilterExpression('   \t ')).toEqual({ ok: true, conditions: [] });
  });

  it('records where each part of a condition starts', () => {
    const result = parseFilterExpression('a = 1 and  bb >= "x y"');
    expect(result.ok && result.conditions.map(condition => condition.at)).toEqual([
      { field: 0, operator: 2, value: 4 },
      { field: 11, operator: 14, value: 17 }
    ]);
  });

  describe('errors', () => {
    it('explains that or is not supported, at the or', () => {
      expect(errorOf('a = 1 or b = 2')).toEqual({ code: 'unsupportedOr', position: 6, token: 'or' });
      expect(errorOf('a = 1 OR b = 2')).toEqual({ code: 'unsupportedOr', position: 6, token: 'OR' });
    });

    it('does not mistake a word that starts with or for the keyword', () => {
      expect(errorOf('a = 1 order')).toEqual({ code: 'expectedAnd', position: 6, token: 'order' });
    });

    it('points at a missing field', () => {
      expect(errorOf('= 5')).toEqual({ code: 'expectedField', position: 0, token: '=' });
      expect(errorOf('a = 1 and = 5')).toEqual({ code: 'expectedField', position: 10, token: '=' });
    });

    it('points at a missing operator, naming the field', () => {
      expect(errorOf('http.status')).toEqual({ code: 'expectedOperator', position: 11, token: 'http.status' });
      expect(errorOf('http.status 500')).toEqual({ code: 'expectedOperator', position: 12, token: 'http.status' });
    });

    it('points at a missing value', () => {
      expect(errorOf('a =')).toEqual({ code: 'expectedValue', position: 3 });
      expect(errorOf('a = >= 5')).toEqual({ code: 'expectedValue', position: 4, token: '>=' });
    });

    it('points at the quote of an unterminated string', () => {
      expect(errorOf('a = "oops')).toEqual({ code: 'unterminatedString', position: 4 });
      expect(errorOf("a = 1 and b = 'oops")).toEqual({ code: 'unterminatedString', position: 14 });
      expect(errorOf('a = 1 and "Account Name = x')).toEqual({ code: 'unterminatedString', position: 10 });
    });

    it('does not take an empty quoted field', () => {
      expect(errorOf('"" = 5')).toEqual({ code: 'expectedField', position: 0, token: '""' });
    });

    it('asks for a condition after a trailing and', () => {
      expect(errorOf('a = 1 and')).toEqual({ code: 'expectedConditionAfterAnd', position: 9 });
      expect(errorOf('a = 1 and   ')).toEqual({ code: 'expectedConditionAfterAnd', position: 12 });
    });

    it('rejects an unquoted value with spaces at the second word', () => {
      expect(errorOf('message = hello world')).toEqual({ code: 'expectedAnd', position: 16, token: 'world' });
    });
  });

  describe('formatting', () => {
    const roundTrips = [
      'http.status >= 500',
      'message = "Read timed out"',
      'message = "say \\"hi\\""',
      'path = "C:\\\\temp"',
      'word = "and"',
      'word = "or"',
      'empty = ""',
      'cmp = ">="',
      'error.code exists',
      'tags[] = vip',
      '[].status >= 500',
      '"Account Name" contains acme',
      '"say \\"hi\\".x" exists',
      '"user" = alice'
    ];

    it.each(roundTrips)('writes %s so that it parses back to the same condition', source => {
      const parsed = conditionsOf(parseFilterExpression(source));
      const written = parsed.map(condition => formatFilterCondition(condition, 'payload')).join(' and ');
      expect(conditionsOf(parseFilterExpression(written))).toEqual(parsed);
    });

    it('leaves plain values bare and quotes the ones that need it', () => {
      expect(formatFilterCondition({ field: 'a', op: '=', value: '500' }, 'payload')).toBe('a = 500');
      expect(formatFilterCondition({ field: 'a', op: '=', value: 'two words' }, 'payload')).toBe('a = "two words"');
      expect(formatFilterCondition({ field: 'a', op: 'exists' }, 'payload')).toBe('a exists');
    });

    it('leaves plain fields bare and quotes the ones that need it', () => {
      expect(formatFilterCondition({ field: '[].status', op: '>=', value: '500' }, 'payload')).toBe('[].status >= 500');
      expect(formatFilterCondition({ field: 'Account Name', op: 'exists' }, 'payload')).toBe('"Account Name" exists');
      expect(formatFilterCondition({ field: 'a=b', op: 'exists' }, 'payload')).toBe('"a=b" exists');
    });

    it('quotes a payload key spelled like a server filter field, and writes the server field bare', () => {
      expect(formatFilterCondition({ field: 'user', op: '=', value: 'alice' }, 'payload')).toBe('"user" = alice');
      expect(formatFilterCondition({ field: 'level', op: 'exists' }, 'payload')).toBe('"level" exists');
      expect(formatFilterCondition({ field: 'user', op: '=', value: 'alice' }, 'server')).toBe('user = alice');
      expect(formatFilterCondition({ field: 'User', op: '=', value: 'alice' }, 'payload')).toBe('User = alice');
    });
  });

  describe('server filter fields', () => {
    const named = (source: string) => {
      const result = parseFilterExpression(source);
      if (!result.ok) {
        throw new Error(source);
      }
      return result.conditions.map(condition => [condition.field, serverFieldOf(condition) ?? 'payload']);
    };

    it('reads an unquoted level, user, since or source as the server filter field, and a quoted one as a payload key', () => {
      expect(named('level >= WARN and user = a and since = 1h and source = s')).toEqual([
        ['level', 'level'],
        ['user', 'user'],
        ['since', 'since'],
        ['source', 'source']
      ]);
      expect(named('"level" = x and \'user\' = a and "since" exists and "source" exists')).toEqual([
        ['level', 'payload'],
        ['user', 'payload'],
        ['since', 'payload'],
        ['source', 'payload']
      ]);
    });

    it('matches server filter fields by their exact spelling', () => {
      expect(named('User = a and LEVEL exists and user.name = b')).toEqual([
        ['User', 'payload'],
        ['LEVEL', 'payload'],
        ['user.name', 'payload']
      ]);
    });
  });
});
