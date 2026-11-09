import {
  mergePayloadFields,
  type CustomLogPayloadField,
  type CustomLogPayloadView,
  type CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import {
  buildPayloadTree,
  countPayloadStates,
  discoverPayloadFields,
  normalizePayloadPath,
  payloadValues,
  resolvePayloadColumns,
  sortLoadedRows
} from '../utils/customLogs/payloadRows';

function parsed(values: Record<string, CustomLogScalar>): CustomLogPayloadView {
  return { state: 'parsed', values, droppedPaths: 0, cutValues: [] };
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map(row => row.id);
}

describe('payload discovery', () => {
  it('groups array indexes under one bracketed path', () => {
    expect(normalizePayloadPath('items[3].variants[10].sku')).toBe('items[].variants[].sku');
    const fields = discoverPayloadFields(
      [
        { path: 'tags[0]', types: ['string'], rows: 5 },
        { path: 'tags[1]', types: ['string'], rows: 3 },
        { path: 'tags[2]', types: ['string'], rows: 1 },
        { path: 'http.status', types: ['number'], rows: 4 }
      ],
      10
    );
    expect(fields.map(field => [field.path, field.rows, field.share])).toEqual([
      ['tags[]', 5, 50],
      ['http.status', 4, 40]
    ]);
  });

  it('calls a path with more than one non-null type mixed', () => {
    const [mixed, onlyNull, onlyOne] = discoverPayloadFields(
      [
        { path: 'http.status', types: ['number', 'string'], rows: 6 },
        { path: 'retry', types: ['null'], rows: 3 },
        { path: 'duration', types: ['number', 'null'], rows: 2 }
      ],
      10
    );
    expect([mixed!.type, onlyNull!.type, onlyOne!.type]).toEqual(['mixed', 'null', 'number']);
  });

  it('lists a path that only appears on the second page', () => {
    const page1: CustomLogPayloadField[] = [{ path: 'orderId', types: ['string'], rows: 50 }];
    const page2: CustomLogPayloadField[] = [
      { path: 'orderId', types: ['string'], rows: 20 },
      { path: 'region', types: ['string'], rows: 7 }
    ];
    const merged = mergePayloadFields(page1, page2);

    expect(discoverPayloadFields(page1, 50).map(field => field.path)).toEqual(['orderId']);
    expect(discoverPayloadFields(merged, 100).map(field => [field.path, field.rows, field.share])).toEqual([
      ['orderId', 70, 70],
      ['region', 7, 7]
    ]);
  });

  it('never reports a present path as 0 percent and never exceeds 100', () => {
    const [rare, all] = discoverPayloadFields(
      [
        { path: 'rare', types: ['string'], rows: 1 },
        { path: 'all', types: ['string'], rows: 500 }
      ],
      1000
    ).sort((a, b) => a.rows - b.rows);
    expect(rare!.share).toBe(1);
    expect(discoverPayloadFields([{ path: 'x', types: ['string'], rows: 9 }], 3)[0]!.share).toBe(100);
    expect(all!.share).toBe(50);
  });
});

describe('reading a row payload', () => {
  const payload = parsed({
    'http.status': 502,
    'tags[0]': 'vip',
    'tags[1]': 'beta',
    'items[0].sku': 'A',
    'items[1].sku': 'B'
  });

  it('reads one path, or every array element through the bracketed path', () => {
    expect(payloadValues(payload, 'http.status')).toEqual([502]);
    expect(payloadValues(payload, 'tags[]')).toEqual(['vip', 'beta']);
    expect(payloadValues(payload, 'tags[1]')).toEqual(['beta']);
    expect(payloadValues(payload, 'items[].sku')).toEqual(['A', 'B']);
    expect(payloadValues(payload, 'missing')).toEqual([]);
    expect(payloadValues(payload, 'tags')).toEqual([]);
  });

  it('has no values when the payload did not parse', () => {
    for (const state of ['invalid', 'text', 'empty', 'hidden'] as const) {
      expect(payloadValues({ state }, 'http.status')).toEqual([]);
    }
    expect(payloadValues(undefined, 'http.status')).toEqual([]);
  });
});

describe('sorting loaded rows', () => {
  const sortedIds = (values: Array<CustomLogScalar | undefined>, dir: 'asc' | 'desc') =>
    sortLoadedRows(
      values.map((value, index) => ({ id: String(index), value })),
      row => row.value,
      dir
    ).map(row => row.id);

  it('orders numbers numerically, not as text', () => {
    expect(sortedIds([10, 9, 100, 2], 'asc')).toEqual(['3', '1', '0', '2']);
    expect(sortedIds([10, 9, 100, 2], 'desc')).toEqual(['2', '0', '1', '3']);
  });

  it('orders a column that mixes numbers and numeric text by value', () => {
    expect(sortedIds([502, '500', 200, '99'], 'asc')).toEqual(['3', '2', '1', '0']);
  });

  it('orders text naturally and keeps unrelated types from throwing', () => {
    expect(sortedIds(['b', 'a10', 'a9', true, 7], 'asc').length).toBe(5);
    expect(sortedIds(['a10', 'a9', 'b'], 'asc')).toEqual(['1', '0', '2']);
  });

  it('puts rows without a value last in either direction', () => {
    expect(sortedIds([undefined, 5, null, 1], 'asc')).toEqual(['3', '1', '0', '2']);
    expect(sortedIds([undefined, 5, null, 1], 'desc')).toEqual(['1', '3', '0', '2']);
  });

  it('keeps the loaded order between equal values', () => {
    expect(sortedIds([1, 1, 1], 'asc')).toEqual(['0', '1', '2']);
    expect(sortedIds([1, 1, 1], 'desc')).toEqual(['0', '1', '2']);
  });
});

describe('summaries', () => {
  it('counts the payload states of the rows', () => {
    const rows = [
      { payload: parsed({}) },
      { payload: parsed({}) },
      { payload: { state: 'invalid' } as CustomLogPayloadView },
      { payload: { state: 'text' } as CustomLogPayloadView },
      { payload: { state: 'empty' } as CustomLogPayloadView },
      { payload: { state: 'hidden' } as CustomLogPayloadView },
      {}
    ];
    expect(countPayloadStates(rows)).toEqual({ parsed: 2, invalid: 1, text: 1, empty: 1, hidden: 1 });
  });
});

describe('payload columns', () => {
  it('puts the mapping defaults first, then the columns this workspace added', () => {
    expect(resolvePayloadColumns({ defaults: ['orderId', 'http.status'], added: ['durationMs'] }, [])).toEqual([
      { path: 'orderId', origin: 'default' },
      { path: 'http.status', origin: 'default' },
      { path: 'durationMs', origin: 'added' }
    ]);
  });

  it('hides a default for this user without losing the others', () => {
    expect(resolvePayloadColumns({ defaults: ['orderId', 'http.status'], added: [] }, ['orderId'])).toEqual([
      { path: 'http.status', origin: 'default' }
    ]);
  });

  it('never repeats a path that is both a default and added', () => {
    expect(resolvePayloadColumns({ defaults: ['a'], added: ['a', 'b', 'b'] }, [])).toEqual([
      { path: 'a', origin: 'default' },
      { path: 'b', origin: 'added' }
    ]);
    expect(resolvePayloadColumns({ defaults: ['a'], added: ['a'] }, ['a'])).toEqual([]);
  });
});

describe('payload tree', () => {
  it('nests flat paths back into groups, with actions on the bracketed path', () => {
    const tree = buildPayloadTree({
      orderId: 'ORD-1',
      'customer.id': '001',
      'customer.tier': 'gold',
      'tags[0]': 'vip',
      'tags[1]': 'beta',
      'items[0].sku': 'A',
      'items[1].sku': 'B'
    });
    expect(tree).toEqual([
      { kind: 'leaf', key: 'orderId', rawPath: 'orderId', path: 'orderId', value: 'ORD-1' },
      {
        kind: 'group',
        key: 'customer',
        children: [
          { kind: 'leaf', key: 'id', rawPath: 'customer.id', path: 'customer.id', value: '001' },
          { kind: 'leaf', key: 'tier', rawPath: 'customer.tier', path: 'customer.tier', value: 'gold' }
        ]
      },
      {
        kind: 'group',
        key: 'tags',
        children: [
          { kind: 'leaf', key: '[0]', rawPath: 'tags[0]', path: 'tags[]', value: 'vip' },
          { kind: 'leaf', key: '[1]', rawPath: 'tags[1]', path: 'tags[]', value: 'beta' }
        ]
      },
      {
        kind: 'group',
        key: 'items',
        children: [
          {
            kind: 'group',
            key: '[0]',
            children: [{ kind: 'leaf', key: 'sku', rawPath: 'items[0].sku', path: 'items[].sku', value: 'A' }]
          },
          {
            kind: 'group',
            key: '[1]',
            children: [{ kind: 'leaf', key: 'sku', rawPath: 'items[1].sku', path: 'items[].sku', value: 'B' }]
          }
        ]
      }
    ]);
  });
});
