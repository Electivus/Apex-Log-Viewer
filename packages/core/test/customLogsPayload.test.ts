import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_LOG_PAYLOAD_LIMITS, customLogTextFormat, type CustomLogPayloadView } from '../src/contracts.ts';
import {
  HIDDEN_DOC,
  decodePayload,
  docOfText,
  readEntrySlot,
  groupArrayIndexes,
  selectPayloadPaths,
  summarizePayloadFields,
  toLongValue,
  type SlotReading
} from '../src/customLogs/payload.ts';

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

test('the page summary groups array indexes, so a long array is one path counted once per row', () => {
  const views = [
    parsed('{"metrics":[{"name":"a","value":1},{"name":"b","value":2},{"name":"c","value":"x"}],"tags":["t1","t2"]}'),
    parsed('{"metrics":[{"name":"d"}],"grid":[[1,2],[3]]}'),
    parsed('[{"status":200},{"status":502}]')
  ];

  assert.deepEqual(summarizePayloadFields(views), [
    { path: 'metrics[].name', types: ['string'], rows: 2 },
    { path: 'metrics[].value', types: ['string', 'number'], rows: 1 },
    { path: 'tags[]', types: ['string'], rows: 1 },
    { path: 'grid[][]', types: ['number'], rows: 1 },
    { path: '[].status', types: ['number'], rows: 1 }
  ]);
  assert.equal(groupArrayIndexes('metrics[12].tags[0]'), 'metrics[].tags[]');
  assert.equal(groupArrayIndexes('order.id'), 'order.id');
});

test('selectPayloadPaths keeps every item for a [] path and one item for an indexed path', () => {
  const long = 'y'.repeat(CUSTOM_LOG_PAYLOAD_LIMITS.valueChars + 1);
  const view = parsed(`{"metrics":[{"name":"a","note":"${long}"},{"name":"b"}],"grid":[[1,2],[3]],"seq":7}`);

  const grouped = selectPayloadPaths(view, new Set(['metrics[].name', 'metrics[].note', 'grid[][]']));
  const indexed = selectPayloadPaths(view, new Set(['metrics[1].name', 'seq']));
  // `[]` stands for every index of the path, as in the panel: a path that mixes `[]` and `[0]` names nothing.
  const mixed = selectPayloadPaths(view, new Set(['grid[0][]']));

  assert.deepEqual((grouped as typeof view).values, {
    'metrics[0].name': 'a',
    'metrics[0].note': long.slice(0, CUSTOM_LOG_PAYLOAD_LIMITS.valueChars),
    'metrics[1].name': 'b',
    'grid[0][0]': 1,
    'grid[0][1]': 2,
    'grid[1][0]': 3
  });
  assert.deepEqual((grouped as typeof view).cutValues, ['metrics[0].note']);
  assert.deepEqual((indexed as typeof view).values, { 'metrics[1].name': 'b', seq: 7 });
  assert.deepEqual((mixed as typeof view).values, {});
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

// ---------------------------------------------------------------------------------------------
// Entry slots and element docs (issue #1240)

const NONE: ReadonlySet<string> = new Set();
const states = (reading: SlotReading) =>
  reading.kind === 'elements'
    ? reading.docs.map(doc => doc.view.state)
    : reading.kind === 'whole'
      ? reading.doc.view.state
      : reading.kind;

test('a slot is blank, one row per element of a JSON array, or the whole field for anything else', () => {
  const cases: [string, unknown, string | string[]][] = [
    ['two objects', '[{"a":1},{"b":2}]', ['parsed', 'parsed']],
    ['an empty array', '[]', []],
    ['null', null, 'blank'],
    ['undefined', undefined, 'blank'],
    ['an empty string', '', 'blank'],
    ['whitespace', ' \n\t', 'blank'],
    ['plain text', 'Order sync failed', 'text'],
    ['broken JSON', '[{"a":1}', 'invalid'],
    ['a JSON object', '{"a":[1,2]}', 'parsed'],
    ['a JSON scalar', '42', 'text'],
    ['a number', 7, 'text'],
    ['mixed elements', '[{"a":1}, 7, "x", null, [1]]', ['parsed', 'text', 'text', 'empty', 'parsed']],
    ['an array with leading blank', '  \n[1]', ['text']]
  ];
  for (const [name, raw, expected] of cases) {
    assert.deepEqual(states(readEntrySlot(raw, NONE)), expected, name);
  }
});

test('an element doc reads the role paths of the element and prints it as JSON; scalars and null have their own text', () => {
  const reading = readEntrySlot(
    '[{"traceId":"t-1","metrics":[{"name":"cpu"}]}, 7, "x", null, [1,2]]',
    new Set(['traceId', 'metrics[0].name'])
  );
  assert.equal(reading.kind, 'elements');
  const docs = reading.kind === 'elements' ? reading.docs : [];
  const [object, seven, x, nothing, array] = docs;

  assert.deepEqual(
    [...object!.picked],
    [
      ['traceId', 't-1'],
      ['metrics[0].name', 'cpu']
    ]
  );
  assert.deepEqual(object!.view, {
    state: 'parsed',
    values: { traceId: 't-1', 'metrics[0].name': 'cpu' },
    droppedPaths: 0,
    cutValues: []
  });
  assert.deepEqual(object!.text(), {
    state: 'value',
    value: JSON.stringify({ traceId: 't-1', metrics: [{ name: 'cpu' }] }, null, 2),
    format: 'json'
  });
  assert.equal(object!.compact(), '{"traceId":"t-1","metrics":[{"name":"cpu"}]}');
  assert.deepEqual(seven!.text(), { state: 'value', value: '7', format: 'text' });
  assert.deepEqual(x!.text(), { state: 'value', value: 'x', format: 'text' });
  assert.equal(seven!.compact(), undefined);
  assert.deepEqual(nothing!.view, { state: 'empty' });
  assert.deepEqual(nothing!.text(), { state: 'empty' });
  assert.deepEqual(array!.view, { state: 'parsed', values: { '[0]': 1, '[1]': 2 }, droppedPaths: 0, cutValues: [] });
  assert.deepEqual(array!.text(), { state: 'value', value: '[\n  1,\n  2\n]', format: 'json' });
});

test('a whole-field doc keeps the field text as its long value, whatever the view', () => {
  for (const raw of ['{"a":1}', '[{"a":1}', 'plain', '42']) {
    const reading = readEntrySlot(raw, NONE);
    assert.equal(reading.kind, 'whole', raw);
    assert.deepEqual(reading.kind === 'whole' && reading.doc.text(), toLongValue(raw), raw);
  }
});

test('picked values are whole and found past the path cap, while the view stays capped and cut', () => {
  const long = 'y'.repeat(CUSTOM_LOG_PAYLOAD_LIMITS.valueChars + 40);
  const many: Record<string, unknown> = {};
  for (let index = 0; index < CUSTOM_LOG_PAYLOAD_LIMITS.paths + 5; index++) many[`k${index}`] = index;
  many.last = long;
  const last = `k${CUSTOM_LOG_PAYLOAD_LIMITS.paths + 4}`;

  const doc = docOfText(JSON.stringify(many), new Set(['k0', last, 'last', 'missing']));

  assert.equal(doc.view.state, 'parsed');
  const view = doc.view as Extract<typeof doc.view, { state: 'parsed' }>;
  assert.equal(Object.keys(view.values).length, CUSTOM_LOG_PAYLOAD_LIMITS.paths);
  assert.equal(view.droppedPaths, 6);
  assert.equal(view.values[last], undefined);
  assert.deepEqual(
    [...doc.picked],
    [
      ['k0', 0],
      [last, CUSTOM_LOG_PAYLOAD_LIMITS.paths + 4],
      ['last', long]
    ]
  );
  assert.equal((doc.picked.get('last') as string).length, long.length);
  assert.equal(doc.picked.has('missing'), false);
});

test('decodePayload is the view of docOfText with nothing picked, and a role path at a container picks nothing', () => {
  for (const raw of ['{"a":{"b":[1,{"c":"d"}]}}', '[1]', '{"a":', 'text', '', null, 3]) {
    assert.deepEqual(docOfText(raw, NONE).view, decodePayload(raw), JSON.stringify(raw));
  }
  assert.deepEqual([...docOfText('{"a":{"b":1}}', new Set(['a'])).picked], []);
  assert.deepEqual(HIDDEN_DOC.view, { state: 'hidden' });
  assert.deepEqual(HIDDEN_DOC.text(), { state: 'hidden' });
  assert.equal(HIDDEN_DOC.compact(), undefined);
});

test('an element nested past what JSON.stringify accepts prints the whole field instead, and has no compact text', () => {
  const depth = 20_000;
  const raw = `[${'['.repeat(depth)}1${']'.repeat(depth)}]`;

  const reading = readEntrySlot(raw, NONE);

  assert.equal(reading.kind, 'elements');
  const [doc] = reading.kind === 'elements' ? reading.docs : [];
  assert.equal(doc!.view.state, 'parsed');
  assert.deepEqual(doc!.text(), toLongValue(raw));
  assert.equal(doc!.compact(), undefined);
});
