import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCustomLogViewerFromWebviewMessage } from '../src/customLogViewerMessages.ts';
import { parseCustomLogsFromWebviewMessage } from '../src/customLogsMessages.ts';
import {
  mergePayloadFields,
  parseCustomLogPayloadColumns,
  parseCustomLogRowId,
  type CustomLogPayloadField
} from '../src/customLogsTypes.ts';

const LOG_ID = 'a015g00000Q2xYzAAB';
const ENTRY_ID = 'a025g00000Hk1AbAAJ';
const EVENT_ID = 'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d';
const ENTRY_OF_EVENT_ID = `${EVENT_ID}-0001`;

test('mergePayloadFields unions types in core order, sums rows and keeps first-seen path order', () => {
  const loaded: CustomLogPayloadField[] = [
    { path: 'http.status', types: ['number'], rows: 3 },
    { path: 'orderId', types: ['string'], rows: 2 }
  ];
  const page: CustomLogPayloadField[] = [
    { path: 'region', types: ['string'], rows: 4 },
    { path: 'http.status', types: ['string', 'number'], rows: 1 }
  ];

  assert.deepEqual(mergePayloadFields(loaded, page), [
    { path: 'http.status', types: ['string', 'number'], rows: 4 },
    { path: 'orderId', types: ['string'], rows: 2 },
    { path: 'region', types: ['string'], rows: 4 }
  ]);
});

test('mergePayloadFields leaves its inputs untouched and treats an empty page as a copy', () => {
  const loaded: CustomLogPayloadField[] = [{ path: 'a', types: ['string'], rows: 1 }];
  const merged = mergePayloadFields(loaded, []);

  merged[0]!.types.push('number');
  merged[0]!.rows = 99;

  assert.deepEqual(loaded, [{ path: 'a', types: ['string'], rows: 1 }]);
  assert.deepEqual(mergePayloadFields([], []), []);
});

test('list parser accepts each webview message and echoes the mount sequence', () => {
  assert.deepEqual(
    parseCustomLogsFromWebviewMessage({ type: 'customLogsReady', mountSequence: 3, sentAt: 1_760_000_000_000 }),
    {
      type: 'customLogsReady',
      mountSequence: 3
    }
  );
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsReady' }), { type: 'customLogsReady' });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsReady', mountSequence: -1 }), {
    type: 'customLogsReady'
  });
  for (const type of ['customLogsRefresh', 'customLogsLoadMore', 'customLogsOpenConfig', 'customLogsOpenEditor']) {
    assert.deepEqual(parseCustomLogsFromWebviewMessage({ type }), { type });
  }
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsSelectOrg', target: '  dev@acme.com ' }), {
    type: 'customLogsSelectOrg',
    target: 'dev@acme.com'
  });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsSelectSource', sourceId: 'nebula-managed' }), {
    type: 'customLogsSelectSource',
    sourceId: 'nebula-managed'
  });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsOpenLog', logId: LOG_ID }), {
    type: 'customLogsOpenLog',
    logId: LOG_ID
  });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsOpenPayload', logId: ENTRY_ID }), {
    type: 'customLogsOpenPayload',
    logId: ENTRY_ID
  });
});

test('a host accepts back a record id or an event id and nothing in between', () => {
  const accepted = [LOG_ID, ENTRY_ID, 'a015g00000Q2xYz', EVENT_ID, ENTRY_OF_EVENT_ID, `${EVENT_ID}-zzzz`];
  const rejected = [
    EVENT_ID.slice(1),
    EVENT_ID.slice(0, -1),
    `${EVENT_ID}0`,
    EVENT_ID.toUpperCase(),
    EVENT_ID.replace(/^e-/, 'x-'),
    `${EVENT_ID}'`,
    ' ' + EVENT_ID,
    'e-' + LOG_ID,
    `${EVENT_ID}-0000`,
    `${EVENT_ID}-001`,
    `${EVENT_ID}-00001`,
    `${EVENT_ID}-000A`,
    `${EVENT_ID}-`,
    `${ENTRY_OF_EVENT_ID}-0001`,
    `${ENTRY_OF_EVENT_ID}0`,
    `${ENTRY_OF_EVENT_ID}'`,
    '',
    null,
    42
  ];

  for (const id of accepted) assert.equal(parseCustomLogRowId(id), id);
  for (const id of rejected) assert.equal(parseCustomLogRowId(id), undefined, JSON.stringify(id));
});

test('every host message that names a row takes an event id', () => {
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsOpenLog', logId: EVENT_ID }), {
    type: 'customLogsOpenLog',
    logId: EVENT_ID
  });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsOpenLog', logId: ENTRY_OF_EVENT_ID }), {
    type: 'customLogsOpenLog',
    logId: ENTRY_OF_EVENT_ID
  });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsOpenPayload', logId: EVENT_ID }), {
    type: 'customLogsOpenPayload',
    logId: EVENT_ID
  });
  assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerOpenEntry', entryId: EVENT_ID }), {
    type: 'customLogViewerOpenEntry',
    entryId: EVENT_ID
  });
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({
      type: 'customLogViewerOpenField',
      target: { kind: 'entry', entryId: EVENT_ID, key: 'message' }
    }),
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: EVENT_ID, key: 'message' } }
  );
  assert.equal(parseCustomLogsFromWebviewMessage({ type: 'customLogsOpenLog', logId: EVENT_ID.slice(1) }), undefined);
});

test('list parser reads the server-side filter and drops anything else', () => {
  assert.deepEqual(
    parseCustomLogsFromWebviewMessage({
      type: 'customLogsSetFilter',
      filter: { minLevel: 'WARN', user: ' dev@acme.com ', since: '24h', ignored: true }
    }),
    { type: 'customLogsSetFilter', filter: { minLevel: 'WARN', user: 'dev@acme.com', since: '24h' } }
  );
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter: {} }), {
    type: 'customLogsSetFilter',
    filter: {}
  });
  for (const since of ['2026-10-29T23:29:49.000Z', '2026-10-29T10:00-03:00', '2026-10-29']) {
    assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter: { since } }), {
      type: 'customLogsSetFilter',
      filter: { since }
    });
  }
});

test('list parser reads minLevel in any case, as core does, and sends the canonical level', () => {
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter: { minLevel: 'warn' } }), {
    type: 'customLogsSetFilter',
    filter: { minLevel: 'WARN' }
  });
});

test('list parser rejects a malformed filter as a whole', () => {
  const rejected = [
    { minLevel: 'WARNING' },
    { minLevel: 3 },
    { user: '' },
    { user: 'x'.repeat(256) },
    { user: 42 },
    { since: '0h' },
    { since: '24' },
    { since: 'yesterday' },
    { since: '12' },
    { since: '2026-13-45' },
    { since: '2026-10-29T10:00' },
    { since: '2026-10-29T10:00:00' },
    { since: '' },
    { since: 'x'.repeat(65) }
  ].map(filter => parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter }));

  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
  assert.equal(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter' }), undefined);
  assert.equal(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter: [] }), undefined);
});

test('list parser reads a source switch as the source alone, whatever filter travels with it', () => {
  for (const filter of [{ minLevel: 'ERROR' }, {}, { minLevel: 'LOUD' }, 'level >= ERROR']) {
    assert.deepEqual(
      parseCustomLogsFromWebviewMessage({ type: 'customLogsSelectSource', sourceId: 'app-log', filter }),
      { type: 'customLogsSelectSource', sourceId: 'app-log' }
    );
  }
});

test('capture messages carry a stop, or a start with the first-use choice when there is one', () => {
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsCapture', action: 'stop' }), {
    type: 'customLogsCapture',
    action: 'stop'
  });
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsCapture', action: 'start' }), {
    type: 'customLogsCapture',
    action: 'start'
  });
  assert.deepEqual(
    parseCustomLogsFromWebviewMessage({ type: 'customLogsCapture', action: 'start', initial: undefined }),
    { type: 'customLogsCapture', action: 'start' }
  );
  for (const initial of ['retained', 'new'] as const) {
    assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsCapture', action: 'start', initial }), {
      type: 'customLogsCapture',
      action: 'start',
      initial
    });
  }
});

test('capture messages drop every field outside the contract', () => {
  assert.deepEqual(
    parseCustomLogsFromWebviewMessage({
      type: 'customLogsCapture',
      action: 'start',
      initial: 'new',
      cursor: 'cometd:7'
    }),
    { type: 'customLogsCapture', action: 'start', initial: 'new' }
  );
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsCapture', action: 'stop', force: true }), {
    type: 'customLogsCapture',
    action: 'stop'
  });
});

test('capture messages reject an unknown action, a choice core reserves for the panel and a choice on stop', () => {
  const rejected = [
    { type: 'customLogsCapture' },
    { type: 'customLogsCapture', action: 'pause' },
    { type: 'customLogsCapture', action: 'START' },
    { type: 'customLogsCapture', action: 7 },
    { type: 'customLogsCapture', action: 'start', initial: 'none' },
    { type: 'customLogsCapture', action: 'start', initial: 'Retained' },
    { type: 'customLogsCapture', action: 'start', initial: null },
    { type: 'customLogsCapture', action: 'start', initial: 1 },
    { type: 'customLogsCapture', action: 'start', initial: ['new'] },
    { type: 'customLogsCapture', action: 'stop', initial: 'new' },
    { type: 'customLogsCapture', action: 'stop', initial: null }
  ].map(parseCustomLogsFromWebviewMessage);

  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
});

test('list parser rejects malformed ids, sources and orgs', () => {
  const rejected = [
    { type: 'customLogsOpenLog', logId: 'short' },
    { type: 'customLogsOpenLog', logId: `${LOG_ID}'` },
    { type: 'customLogsOpenLog', logId: 'a015g00000Q2xYzAABX' },
    { type: 'customLogsOpenLog' },
    { type: 'customLogsOpenPayload', logId: '../../etc/passwd' },
    { type: 'customLogsSelectSource', sourceId: 'Nebula' },
    { type: 'customLogsSelectSource', sourceId: '1app' },
    { type: 'customLogsSelectSource', sourceId: 'a'.repeat(41) },
    { type: 'customLogsSelectOrg', target: '' },
    { type: 'customLogsSelectOrg', target: 'x'.repeat(321) },
    { type: 'tailStart' },
    { type: 'refresh' },
    { type: 'customLogViewerReady' },
    { type: 'unknown' },
    [],
    null,
    'customLogsRefresh'
  ].map(parseCustomLogsFromWebviewMessage);

  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
});

test('a payload column change names one bounded path and whether it is shown', () => {
  for (const type of ['customLogsShowPayloadColumn', 'customLogViewerShowPayloadColumn'] as const) {
    const parse =
      type === 'customLogsShowPayloadColumn'
        ? parseCustomLogsFromWebviewMessage
        : parseCustomLogViewerFromWebviewMessage;
    assert.deepEqual(parse({ type, path: 'tags[]', shown: true }), { type, path: 'tags[]', shown: true });
    assert.deepEqual(parse({ type, path: 'http.status', shown: false }), { type, path: 'http.status', shown: false });
    for (const rejected of [
      { type, path: 'http.status' },
      { type, path: 'http.status', shown: 'true' },
      { type, path: '', shown: true },
      { type, path: ' padded', shown: true },
      { type, path: 'a\nb', shown: true },
      { type, path: 'x'.repeat(256), shown: true },
      { type, path: ['http.status'], shown: true },
      { type, added: ['http.status'] }
    ]) {
      assert.equal(parse(rejected), undefined, JSON.stringify(rejected));
    }
  }
});

test('stored payload columns are bounded, deduplicated and free of control characters', () => {
  assert.deepEqual(parseCustomLogPayloadColumns(['http.status', 'tags[]', 'http.status']), ['http.status', 'tags[]']);
  assert.deepEqual(parseCustomLogPayloadColumns([]), []);

  const fifty = Array.from({ length: 50 }, (_, index) => `path${index}`);
  assert.equal(parseCustomLogPayloadColumns(fifty)?.length, 50);
  assert.equal(parseCustomLogPayloadColumns([...fifty, 'path50']), undefined);
  assert.equal(parseCustomLogPayloadColumns(['x'.repeat(255)])?.length, 1);
  assert.equal(parseCustomLogPayloadColumns(['x'.repeat(256)]), undefined);
  assert.equal(parseCustomLogPayloadColumns(['']), undefined);
  assert.equal(parseCustomLogPayloadColumns([' padded']), undefined);
  assert.equal(parseCustomLogPayloadColumns(['a\nb']), undefined);
  assert.equal(parseCustomLogPayloadColumns(['ok', 7]), undefined);
  assert.equal(parseCustomLogPayloadColumns('http.status'), undefined);
});

test('viewer parser accepts each webview message', () => {
  for (const type of [
    'customLogViewerReady',
    'customLogViewerRefresh',
    'customLogViewerLoadMoreEntries',
    'customLogViewerOpenApexLog'
  ]) {
    assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type, sentAt: 1 }), { type });
  }
  assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerOpenEntry', entryId: ENTRY_ID }), {
    type: 'customLogViewerOpenEntry',
    entryId: ENTRY_ID
  });
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerShowPayloadColumn', path: 'a.b', shown: true }),
    { type: 'customLogViewerShowPayloadColumn', path: 'a.b', shown: true }
  );
  assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerCopyText', text: 'Log-000739' }), {
    type: 'customLogViewerCopyText',
    text: 'Log-000739'
  });
});

test('viewer parser reads open-field targets by key and never by text', () => {
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({
      type: 'customLogViewerCopyField',
      target: { kind: 'entry', entryId: ENTRY_ID, key: 'message', text: 'smuggled preview' }
    }),
    { type: 'customLogViewerCopyField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'message' } }
  );
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({
      type: 'customLogViewerOpenField',
      target: { kind: 'entry', entryId: ENTRY_ID, key: 'StackTrace__c', value: 'smuggled text' }
    }),
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'StackTrace__c' } }
  );
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({
      type: 'customLogViewerOpenField',
      target: { kind: 'entry', entryId: ENTRY_ID, key: 'message' }
    }),
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'message' } }
  );
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({
      type: 'customLogViewerOpenField',
      target: { kind: 'logPayload', extra: 1 }
    }),
    { type: 'customLogViewerOpenField', target: { kind: 'logPayload' } }
  );
});

test('viewer parser rejects malformed targets, ids and copy text', () => {
  const rejected = [
    { type: 'customLogViewerOpenField' },
    { type: 'customLogViewerOpenField', target: { kind: 'apexLog' } },
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID } },
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: 'bad', key: 'message' } },
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: '1bad' } },
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'a b' } },
    { type: 'customLogViewerCopyField', text: 'whole message' },
    { type: 'customLogViewerCopyField', target: { kind: 'entry', entryId: 'bad', key: 'message' } },
    { type: 'customLogViewerOpenEntry', entryId: 'bad' },
    { type: 'customLogViewerOpenApexLogs' },
    { type: 'customLogViewerCopyText', text: '' },
    { type: 'customLogViewerCopyText', text: 'x'.repeat(1_000_001) },
    { type: 'customLogViewerShowPayloadColumn', path: 'a' },
    { type: 'customLogsReady' },
    { type: 'logViewerReady' },
    null,
    []
  ].map(parseCustomLogViewerFromWebviewMessage);

  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
});

test('viewer open-apex-log message carries no id even when the webview sends one', () => {
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerOpenApexLog', logId: '07L5g00000XyZabEAE' }),
    {
      type: 'customLogViewerOpenApexLog'
    }
  );
});
