import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_LOG_PAYLOAD_LIMITS, customLogTextFormat, type CustomLogPayloadView } from '../src/contracts.ts';
import { decodePayload, selectPayloadPaths, summarizePayloadFields, toLongValue } from '../src/customLogs/payload.ts';

function parsed(raw: string): Extract<CustomLogPayloadView, { state: 'parsed' }> {
  const view = decodePayload(raw);
  assert.equal(view.state, 'parsed', raw.slice(0, 80));
  return view as Extract<CustomLogPayloadView, { state: 'parsed' }>;
}

test('nested objects and arrays flatten to dot paths with array indexes, in document order', () => {
  const view = parsed(
    '{"orderId":"ORD-1","http":{"status":502,"retry":false,"body":null},"lines":[{"sku":"A","qty":2},{"sku":"B"}],"tags":["vip","new"]}'
  );

  assert.deepEqual(view.values, {
    orderId: 'ORD-1',
    'http.status': 502,
    'http.retry': false,
    'http.body': null,
    'lines[0].sku': 'A',
    'lines[0].qty': 2,
    'lines[1].sku': 'B',
    'tags[0]': 'vip',
    'tags[1]': 'new'
  });
  assert.deepEqual(Object.keys(view.values)[0], 'orderId');
  assert.equal(view.droppedPaths, 0);
  assert.deepEqual(view.cutValues, []);
});

test('a top-level array uses bare indexes and empty containers add no path', () => {
  assert.deepEqual(parsed('[{"a":1},[2],{}, []]').values, { '[0].a': 1, '[1][0]': 2 });
  assert.deepEqual(parsed('{"a":{},"b":[]}').values, {});
});

test('paths past the cap are counted, and strings past the cap are cut and named', () => {
  const many = Object.fromEntries(
    Array.from({ length: CUSTOM_LOG_PAYLOAD_LIMITS.paths + 7 }, (_, index) => [`k${index}`, index])
  );
  const long = 'x'.repeat(CUSTOM_LOG_PAYLOAD_LIMITS.valueChars + 40);

  const capped = parsed(JSON.stringify(many));
  const cut = parsed(JSON.stringify({ body: long, short: 'ok' }));

  assert.equal(Object.keys(capped.values).length, CUSTOM_LOG_PAYLOAD_LIMITS.paths);
  assert.equal(capped.droppedPaths, 7);
  assert.equal(Object.keys(capped.values).at(-1), `k${CUSTOM_LOG_PAYLOAD_LIMITS.paths - 1}`);
  assert.equal((cut.values.body as string).length, CUSTOM_LOG_PAYLOAD_LIMITS.valueChars);
  assert.deepEqual(cut.cutValues, ['body']);
  assert.equal(cut.values.short, 'ok');
});

test('text that starts like JSON but does not parse is invalid, anything else is text, blank is empty', () => {
  assert.deepEqual(decodePayload('{"a":'), { state: 'invalid' });
  assert.deepEqual(decodePayload('  [1, 2'), { state: 'invalid' });
  assert.deepEqual(decodePayload('Order sync failed'), { state: 'text' });
  assert.deepEqual(decodePayload('42'), { state: 'text' });
  assert.deepEqual(decodePayload('"quoted"'), { state: 'text' });
  assert.deepEqual(decodePayload('true'), { state: 'text' });
  assert.deepEqual(decodePayload('null'), { state: 'text' });
  assert.deepEqual(decodePayload(''), { state: 'empty' });
  assert.deepEqual(decodePayload('  \n '), { state: 'empty' });
  assert.deepEqual(decodePayload(null), { state: 'empty' });
  assert.deepEqual(decodePayload(undefined), { state: 'empty' });
});

test('hostile keys stay data and a very deep payload cannot overflow the stack', () => {
  const view = parsed('{"__proto__":{"polluted":1},"constructor":"x"}');
  assert.deepEqual(Object.keys(view.values), ['__proto__.polluted', 'constructor']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const depth = 20_000;
  const deep = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
  const state = decodePayload(deep).state;
  assert.ok(state === 'parsed' || state === 'invalid', state);
});

test('the page summary lists every path with its types and the rows that have it, over whole payloads', () => {
  const views = [
    parsed('{"orderId":"A","http":{"status":502}}'),
    parsed('{"orderId":"B","http":{"status":"n/a"},"seq":1}'),
    { state: 'text' } as const,
    { state: 'invalid' } as const,
    parsed('{"http":{"status":null}}')
  ];

  assert.deepEqual(summarizePayloadFields(views), [
    { path: 'orderId', types: ['string'], rows: 2 },
    { path: 'http.status', types: ['string', 'number', 'null'], rows: 3 },
    { path: 'seq', types: ['number'], rows: 1 }
  ]);
  assert.deepEqual(summarizePayloadFields([{ state: 'empty' }]), []);
});

test('selectPayloadPaths trims a parsed view and lets the other states through', () => {
  const view = parsed(`{"a":1,"b":"${'y'.repeat(CUSTOM_LOG_PAYLOAD_LIMITS.valueChars + 1)}","c":3}`);

  const trimmed = selectPayloadPaths(view, new Set(['a', 'b']));
  const onlyA = selectPayloadPaths(view, new Set(['a']));

  assert.deepEqual(Object.keys((trimmed as typeof view).values), ['a', 'b']);
  assert.deepEqual((trimmed as typeof view).cutValues, ['b']);
  assert.deepEqual((onlyA as typeof view).cutValues, []);
  assert.deepEqual(selectPayloadPaths({ state: 'text' }, new Set(['a'])), { state: 'text' });
  assert.deepEqual(selectPayloadPaths({ state: 'hidden' }, new Set()), { state: 'hidden' });
});

test('customLogTextFormat, exported for the extension, is the rule a long value uses', () => {
  const cases: [string, 'json' | 'text'][] = [
    ['{"a":1}', 'json'],
    ['  [1, 2]\n', 'json'],
    ['{}', 'json'],
    ['{"a":', 'text'],
    ['42', 'text'],
    ['"quoted"', 'text'],
    ['{not json}', 'text'],
    ['plain text', 'text'],
    ['', 'text']
  ];

  for (const [text, format] of cases) {
    assert.equal(customLogTextFormat(text), format, text);
    const long = toLongValue(` ${text} `);
    if (long.state === 'value') assert.equal(long.format, format, text);
  }
});

test('a long value says whether it is JSON and carries the framework truncation flag only when mapped', () => {
  assert.deepEqual(toLongValue('{"Name":"Probe"}'), {
    state: 'value',
    value: '{"Name":"Probe"}',
    format: 'json'
  });
  assert.deepEqual(toLongValue('[1,2]', { truncated: true }), {
    state: 'value',
    value: '[1,2]',
    format: 'json',
    truncated: true
  });
  assert.deepEqual(toLongValue('{"broken":'), { state: 'value', value: '{"broken":', format: 'text' });
  assert.deepEqual(toLongValue('AnonymousBlock: line 7, column 1', { truncated: false }), {
    state: 'value',
    value: 'AnonymousBlock: line 7, column 1',
    format: 'text',
    truncated: false
  });
  assert.deepEqual(toLongValue('  '), { state: 'empty' });
  assert.deepEqual(toLongValue(null), { state: 'empty' });
});
