import { parseFilterExpression, type FilterCondition } from '../utils/customLogs/filterGrammar';
import {
  acceptGuidedItem,
  applyServerCondition,
  clearServerFilter,
  computeGuidedStage,
  serverChips,
  type GuidedContext,
  type GuidedField
} from '../utils/customLogs/guidedFilter';

const fields: GuidedField[] = [
  { path: 'level', kind: 'server' },
  { path: 'user', kind: 'server' },
  { path: 'since', kind: 'server' },
  { path: 'http.status', kind: 'payload', type: 'number', share: 52 },
  { path: 'http.method', kind: 'payload', type: 'string', share: 52 },
  { path: 'cacheHit', kind: 'payload', type: 'boolean', share: 20 },
  { path: 'durationMs', kind: 'payload', type: 'mixed', share: 58 },
  { path: 'orderId', kind: 'payload', type: 'string', share: 65 }
];

const context: GuidedContext = {
  fields,
  valuesFor: (field, prefix) =>
    (field === 'http.status'
      ? [
          { value: '500', count: 8 },
          { value: '200', count: 7 },
          { value: '502', count: 1 }
        ]
      : [{ value: 'two words', count: 2 }]
    ).filter(item => item.value.includes(prefix))
};

function condition(source: string): FilterCondition {
  const result = parseFilterExpression(source);
  if (!result.ok) {
    throw new Error(source);
  }
  return result.conditions[0]!;
}

describe('guided filter input', () => {
  it('offers the server fields before payload paths while a field is being typed', () => {
    const stage = computeGuidedStage('', context);
    expect(stage.stage).toBe('field');
    expect(stage.stage === 'field' && stage.items.map(item => item.path)).toEqual([
      'level',
      'user',
      'since',
      'http.status',
      'http.method',
      'cacheHit',
      'durationMs',
      'orderId'
    ]);
  });

  it('narrows fields by what was typed, prefix matches first', () => {
    const stage = computeGuidedStage('stat', context);
    expect(stage.stage === 'field' && stage.items.map(item => item.path)).toEqual(['http.status']);
    const byPrefix = computeGuidedStage('o', context);
    expect(byPrefix.stage === 'field' && byPrefix.items[0]?.path).toBe('orderId');
  });

  it('moves to the operators of the field once a space follows it', () => {
    expect(computeGuidedStage('http.status ', context)).toEqual({
      stage: 'operator',
      field: 'http.status',
      items: ['=', '!=', '>', '>=', '<', '<=', 'exists']
    });
    expect(computeGuidedStage('http.method ', context)).toMatchObject({ items: ['=', '!=', 'contains', 'exists'] });
    expect(computeGuidedStage('cacheHit ', context)).toMatchObject({ items: ['=', '!=', 'exists'] });
    expect(computeGuidedStage('durationMs ', context)).toMatchObject({
      items: expect.arrayContaining(['>=', 'contains', 'exists'])
    });
    expect(computeGuidedStage('level ', context)).toMatchObject({ items: ['>='] });
    expect(computeGuidedStage('user ', context)).toMatchObject({ items: ['='] });
  });

  it('filters operators by what was typed', () => {
    expect(computeGuidedStage('http.status >', context)).toMatchObject({ stage: 'operator', items: ['>', '>='] });
    expect(computeGuidedStage('http.status ex', context)).toMatchObject({ stage: 'operator', items: ['exists'] });
  });

  it('moves to the values of the field once the operator is complete', () => {
    const stage = computeGuidedStage('http.status >= ', context);
    expect(stage).toEqual({
      stage: 'value',
      field: 'http.status',
      op: '>=',
      items: [
        { value: '500', count: 8 },
        { value: '200', count: 7 },
        { value: '502', count: 1 }
      ]
    });
    expect(computeGuidedStage('http.status = 50', context)).toMatchObject({
      stage: 'value',
      items: [
        { value: '500', count: 8 },
        { value: '502', count: 1 }
      ]
    });
  });

  it('ignores a quote the user already typed when it looks up values', () => {
    expect(computeGuidedStage('note = "two', context)).toMatchObject({
      stage: 'value',
      items: [{ value: 'two words' }]
    });
  });

  it('is ready to commit as soon as exists is complete', () => {
    expect(computeGuidedStage('error.code exists', context)).toMatchObject({ stage: 'operator' });
    expect(computeGuidedStage('error.code exists ', context)).toEqual({
      stage: 'commit',
      field: 'error.code',
      op: 'exists'
    });
  });

  describe('accepting a suggestion', () => {
    it('writes the field and waits for the operator', () => {
      const stage = computeGuidedStage('stat', context);
      expect(acceptGuidedItem(stage, 0)).toEqual({ text: 'http.status ', commit: false });
    });

    it('writes the operator and waits for the value, except exists which commits', () => {
      const stage = computeGuidedStage('http.status ', context);
      expect(acceptGuidedItem(stage, 3)).toEqual({ text: 'http.status >= ', commit: false });
      expect(acceptGuidedItem(stage, 6)).toEqual({ text: 'http.status exists', commit: true });
    });

    it('commits the value, quoted when it needs it', () => {
      expect(acceptGuidedItem(computeGuidedStage('http.status >= ', context), 0)).toEqual({
        text: 'http.status >= 500',
        commit: true
      });
      expect(acceptGuidedItem(computeGuidedStage('note = ', context), 0)).toEqual({
        text: 'note = "two words"',
        commit: true
      });
    });

    it('returns nothing for a position past the list', () => {
      expect(acceptGuidedItem(computeGuidedStage('http.status >= ', context), 9)).toBeUndefined();
    });
  });
});

describe('server-side conditions', () => {
  const ready = { filter: {}, capabilities: { levelFilter: true, userFilter: true }, sourceIds: ['nebula', 'app-log'] };

  it('turns level into the minimum level, whatever the case', () => {
    expect(applyServerCondition(condition('level >= warn'), ready)).toEqual({
      ok: true,
      apply: { kind: 'filter', filter: { minLevel: 'WARN' } }
    });
  });

  it('keeps the other server filters when one changes', () => {
    const current = { ...ready, filter: { user: 'dev@acme.com', since: '24h' } };
    expect(applyServerCondition(condition('level >= ERROR'), current)).toEqual({
      ok: true,
      apply: { kind: 'filter', filter: { user: 'dev@acme.com', since: '24h', minLevel: 'ERROR' } }
    });
    expect(applyServerCondition(condition('user = other@acme.com'), current)).toMatchObject({
      apply: { filter: { user: 'other@acme.com', since: '24h' } }
    });
  });

  it('accepts a duration or an instant for since', () => {
    expect(applyServerCondition(condition('since = 24h'), ready)).toMatchObject({
      ok: true,
      apply: { filter: { since: '24h' } }
    });
    expect(applyServerCondition(condition('since = 2026-10-29T10:00:00Z'), ready)).toMatchObject({
      ok: true,
      apply: { filter: { since: '2026-10-29T10:00:00Z' } }
    });
  });

  it('switches source by id', () => {
    expect(applyServerCondition(condition('source = app-log'), ready)).toEqual({
      ok: true,
      apply: { kind: 'source', sourceId: 'app-log' }
    });
  });

  it('reports what is wrong and where', () => {
    expect(applyServerCondition(condition('level = ERROR'), ready)).toEqual({
      ok: false,
      error: { code: 'serverOperator', field: 'level', allowed: ['>='], at: 6 }
    });
    expect(applyServerCondition(condition('level >= LOUD'), ready)).toEqual({
      ok: false,
      error: { code: 'serverLevel', at: 9 }
    });
    expect(applyServerCondition(condition('since = yesterday'), ready)).toEqual({
      ok: false,
      error: { code: 'serverSince', at: 8 }
    });
    expect(applyServerCondition(condition('source = nope'), ready)).toEqual({
      ok: false,
      error: { code: 'serverSource', at: 9 }
    });
  });

  it('refuses level and user when the source cannot filter by them', () => {
    const limited = { ...ready, capabilities: { levelFilter: false, userFilter: false } };
    expect(applyServerCondition(condition('level >= WARN'), limited)).toEqual({
      ok: false,
      error: { code: 'serverUnsupported', field: 'level', at: 0 }
    });
    expect(applyServerCondition(condition('user = a'), limited)).toEqual({
      ok: false,
      error: { code: 'serverUnsupported', field: 'user', at: 0 }
    });
  });

  it('shows one chip per active server filter and clears one at a time', () => {
    const filter = { minLevel: 'WARN' as const, user: 'dev@acme.com', since: '7d' };
    expect(serverChips(filter)).toEqual([
      { field: 'level', op: '>=', value: 'WARN' },
      { field: 'user', op: '=', value: 'dev@acme.com' },
      { field: 'since', op: '=', value: '7d' }
    ]);
    expect(clearServerFilter(filter, 'level')).toEqual({ user: 'dev@acme.com', since: '7d' });
    expect(clearServerFilter(filter, 'user')).toEqual({ minLevel: 'WARN', since: '7d' });
    expect(clearServerFilter(filter, 'since')).toEqual({ minLevel: 'WARN', user: 'dev@acme.com' });
    expect(serverChips({})).toEqual([]);
  });
});
