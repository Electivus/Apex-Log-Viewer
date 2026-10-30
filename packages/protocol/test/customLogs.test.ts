import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCustomLogViewerFromWebviewMessage } from '../src/customLogViewerMessages.ts';
import { parseCustomLogsFromWebviewMessage } from '../src/customLogsMessages.ts';
import { mergePayloadFields, parseCustomLogPayloadColumns, type CustomLogPayloadField } from '../src/customLogsTypes.ts';

const LOG_ID = 'a015g00000Q2xYzAAB';
const ENTRY_ID = 'a025g00000Hk1AbAAJ';

test('mergePayloadFields unions types, sums rows and keeps first-seen order', () => {
  const loaded: CustomLogPayloadField[] = [
    { path: 'http.status', types: ['number'], rows: 3 },
    { path: 'orderId', types: ['string'], rows: 2 }
  ];
  const page: CustomLogPayloadField[] = [
    { path: 'region', types: ['string'], rows: 4 },
    { path: 'http.status', types: ['string', 'number'], rows: 1 }
  ];

  assert.deepEqual(mergePayloadFields(loaded, page), [
    { path: 'http.status', types: ['number', 'string'], rows: 4 },
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
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsReady', mountSequence: 3, sentAt: 1_760_000_000_000 }), {
    type: 'customLogsReady',
    mountSequence: 3
  });
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
  assert.deepEqual(
    parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter: { since: '2026-10-29T23:29:49.000Z' } }),
    { type: 'customLogsSetFilter', filter: { since: '2026-10-29T23:29:49.000Z' } }
  );
});

test('list parser rejects a malformed filter as a whole', () => {
  const rejected = [
    { minLevel: 'WARNING' },
    { minLevel: 'warn' },
    { minLevel: 3 },
    { user: '' },
    { user: 'x'.repeat(256) },
    { user: 42 },
    { since: '0h' },
    { since: '24' },
    { since: 'yesterday' },
    { since: '12' },
    { since: '2026-13-45' },
    { since: '' },
    { since: 'x'.repeat(65) }
  ].map(filter => parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter }));

  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
  assert.equal(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter' }), undefined);
  assert.equal(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetFilter', filter: [] }), undefined);
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

test('payload columns are bounded, deduplicated and free of control characters', () => {
  assert.deepEqual(
    parseCustomLogsFromWebviewMessage({ type: 'customLogsSetPayloadColumns', added: ['http.status', 'tags[]', 'http.status'] }),
    { type: 'customLogsSetPayloadColumns', added: ['http.status', 'tags[]'] }
  );
  assert.deepEqual(parseCustomLogsFromWebviewMessage({ type: 'customLogsSetPayloadColumns', added: [] }), {
    type: 'customLogsSetPayloadColumns',
    added: []
  });

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
  assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerSetPayloadColumns', added: ['a.b'] }), {
    type: 'customLogViewerSetPayloadColumns',
    added: ['a.b']
  });
  assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerCopyText', text: 'Log-000739' }), {
    type: 'customLogViewerCopyText',
    text: 'Log-000739'
  });
});

test('viewer parser reads open-field targets by key and never by text', () => {
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({
      type: 'customLogViewerOpenField',
      target: { kind: 'entry', entryId: ENTRY_ID, key: 'StackTrace__c', value: 'smuggled text' }
    }),
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'StackTrace__c' } }
  );
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'message' } }),
    { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_ID, key: 'message' } }
  );
  assert.deepEqual(
    parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerOpenField', target: { kind: 'logPayload', extra: 1 } }),
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
    { type: 'customLogViewerOpenEntry', entryId: 'bad' },
    { type: 'customLogViewerOpenApexLogs' },
    { type: 'customLogViewerCopyText', text: '' },
    { type: 'customLogViewerCopyText', text: 'x'.repeat(1_000_001) },
    { type: 'customLogViewerSetPayloadColumns', added: 'a' },
    { type: 'customLogsReady' },
    { type: 'logViewerReady' },
    null,
    []
  ].map(parseCustomLogViewerFromWebviewMessage);

  assert.deepEqual(rejected, Array(rejected.length).fill(undefined));
});

test('viewer open-apex-log message carries no id even when the webview sends one', () => {
  assert.deepEqual(parseCustomLogViewerFromWebviewMessage({ type: 'customLogViewerOpenApexLog', logId: '07L5g00000XyZabEAE' }), {
    type: 'customLogViewerOpenApexLog'
  });
});
