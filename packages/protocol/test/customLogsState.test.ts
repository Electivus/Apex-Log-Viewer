import assert from 'node:assert/strict';
import test from 'node:test';

import type { CustomLogsToWebviewMessage } from '../src/customLogsMessages.ts';
import {
  initialCustomLogsView,
  reduceCustomLogsView,
  replayCustomLogsView,
  type CustomLogsViewState
} from '../src/customLogsState.ts';
import {
  CUSTOM_LOGS_LIVE_ROW_CAP,
  type CustomLogCaptureView,
  type CustomLogColumn,
  type CustomLogRow,
  type CustomLogSourceView
} from '../src/customLogsTypes.ts';

const SOURCE: CustomLogSourceView = {
  id: 'nebula',
  label: 'Nebula Logger',
  origin: 'builtin',
  shape: 'transactions',
  hiddenFields: [],
  capabilities: { levelFilter: true, userFilter: true, apexLogLink: true },
  payload: {},
  state: 'ready'
};

function row(id: string): CustomLogRow {
  return { id, time: '2026-10-29T23:41:07.000Z', extra: {} };
}

const MESSAGES: CustomLogsToWebviewMessage[] = [
  { type: 'customLogsInit', locale: 'pt-br', surface: 'editor' },
  { type: 'customLogsOrgs', data: [{ username: 'dev@acme.com', alias: 'acme' }], selected: 'dev@acme.com' },
  { type: 'customLogsSources', data: [SOURCE], selected: 'nebula', issues: [] },
  { type: 'customLogsFilter', value: { minLevel: 'WARN', since: '24h' } },
  { type: 'customLogsPayloadColumns', value: { defaults: ['orderId'], added: ['http.status'] } },
  { type: 'customLogsLoading', value: true },
  {
    type: 'customLogsPage',
    mode: 'replace',
    columns: [{ key: 'Category__c', label: 'Category' }],
    rows: [row('a015g00000Q2xYzAAB'), row('a015g00000Q2xYzAAC')],
    payloadFields: [{ path: 'orderId', types: ['string'], rows: 2 }],
    hasMore: true
  },
  {
    type: 'customLogsPage',
    mode: 'append',
    columns: [{ key: 'Category__c', label: 'Category' }],
    rows: [row('a015g00000Q2xYzAAD')],
    payloadFields: [
      { path: 'orderId', types: ['number'], rows: 1 },
      { path: 'region', types: ['string'], rows: 1 }
    ],
    hasMore: false
  },
  { type: 'customLogsLoading', value: false },
  { type: 'customLogsError', message: 'INVALID_SESSION_ID' }
];

function reduceAll(messages: readonly CustomLogsToWebviewMessage[], from = initialCustomLogsView) {
  return messages.reduce(reduceCustomLogsView, from);
}

test('every message lands in the state it names', () => {
  const state = reduceAll(MESSAGES);

  assert.equal(state.locale, 'pt-br');
  assert.equal(state.surface, 'editor');
  assert.deepEqual(state.orgs, { data: [{ username: 'dev@acme.com', alias: 'acme' }], selected: 'dev@acme.com' });
  assert.deepEqual(state.sources, { data: [SOURCE], selected: 'nebula', issues: [] });
  assert.deepEqual(state.filter, { minLevel: 'WARN', since: '24h' });
  assert.deepEqual(state.payloadColumns, { defaults: ['orderId'], added: ['http.status'] });
  assert.equal(state.loading, false);
  assert.equal(state.error, 'INVALID_SESSION_ID');
});

test('a replace page swaps the rows and an append page adds to them, merging the payload fields', () => {
  const state = reduceAll(MESSAGES);

  assert.deepEqual(
    state.page?.rows.map(item => item.id),
    ['a015g00000Q2xYzAAB', 'a015g00000Q2xYzAAC', 'a015g00000Q2xYzAAD']
  );
  assert.deepEqual(state.page?.payloadFields, [
    { path: 'orderId', types: ['string', 'number'], rows: 3 },
    { path: 'region', types: ['string'], rows: 1 }
  ]);
  assert.equal(state.page?.hasMore, false);

  const replaced = reduceCustomLogsView(state, {
    type: 'customLogsPage',
    mode: 'replace',
    columns: [],
    rows: [],
    payloadFields: [],
    hasMore: false
  });
  assert.deepEqual(replaced.page, { columns: [], rows: [], payloadFields: [], hasMore: false });
});

test('an append page with nothing loaded yet starts the page', () => {
  const state = reduceCustomLogsView(initialCustomLogsView, {
    type: 'customLogsPage',
    mode: 'append',
    columns: [],
    rows: [row('a015g00000Q2xYzAAB')],
    payloadFields: [],
    hasMore: true
  });

  assert.deepEqual(state.page?.rows, [row('a015g00000Q2xYzAAB')]);
});

test('an empty append page only changes hasMore, which is how paging stops without clearing the rows', () => {
  const loaded = reduceAll(MESSAGES.slice(0, 7));
  const stopped = reduceCustomLogsView(loaded, {
    type: 'customLogsPage',
    mode: 'append',
    columns: loaded.page!.columns,
    rows: [],
    payloadFields: [],
    hasMore: false
  });

  assert.deepEqual(stopped.page, { ...loaded.page, hasMore: false });
});

test('replaying a state and reducing it from empty gives the same state', () => {
  const prefixes = MESSAGES.map((_, index) => MESSAGES.slice(0, index + 1));
  for (const prefix of [[], ...prefixes]) {
    const state = reduceAll(prefix);
    assert.deepEqual(reduceAll(replayCustomLogsView(state)), state, `after ${prefix.length} messages`);
  }
});

test('the replay starts with init and ends with the transient state, in the order the webview expects', () => {
  const types = (state: CustomLogsViewState) => replayCustomLogsView(state).map(message => message.type);

  assert.deepEqual(types(reduceAll(MESSAGES)), [
    'customLogsInit',
    'customLogsOrgs',
    'customLogsSources',
    'customLogsFilter',
    'customLogsPayloadColumns',
    'customLogsPage',
    'customLogsLoading',
    'customLogsError'
  ]);
  assert.deepEqual(types(initialCustomLogsView), [
    'customLogsFilter',
    'customLogsPayloadColumns',
    'customLogsLoading',
    'customLogsError'
  ]);
});

test('the reducer never changes the state or the messages it was given', () => {
  const before = reduceAll(MESSAGES.slice(0, 7));
  const snapshot = structuredClone(before);
  const append = MESSAGES[7]!;
  const appendSnapshot = structuredClone(append);

  reduceCustomLogsView(before, append);

  assert.deepEqual(before, snapshot);
  assert.deepEqual(append, appendSnapshot);
});

const BASE_MS = 1_790_000_000_000;

function eventRow(offsetMs: number, fields: Partial<CustomLogRow> = {}): CustomLogRow {
  const id = [
    'e',
    (BASE_MS + offsetMs).toString(36).padStart(9, '0'),
    '0'.repeat(10),
    offsetMs.toString(16).padStart(32, '0')
  ].join('-');
  return { id, time: new Date(BASE_MS + offsetMs).toISOString(), extra: {}, ...fields };
}

const EVENT_SOURCE: CustomLogSourceView = { ...SOURCE, id: 'app-events', label: 'App events', shape: 'events' };

const LIVE: CustomLogCaptureView = {
  capture: { state: 'live', basis: 'quiet' },
  store: {
    state: 'captured',
    eventsRoot: '/repo/apexlogs/orgs/dev/events/App_Log__e',
    lastCaptureAt: '2026-10-30T17:58:52.311Z',
    sizeBytes: 19_293_184,
    retentionDays: 30,
    gaps: []
  },
  wanted: true
};

function eventPage(rows: CustomLogRow[], hasMore = false, columns: CustomLogColumn[] = []): CustomLogsToWebviewMessage {
  return {
    type: 'customLogsPage',
    mode: 'replace',
    columns,
    rows,
    payloadFields: [{ path: 'orderId', types: ['string'], rows: rows.length }],
    hasMore
  };
}

function liveRows(rows: CustomLogRow[]): CustomLogsToWebviewMessage {
  return {
    type: 'customLogsLiveRows',
    rows,
    payloadFields: [{ path: 'orderId', types: ['string'], rows: rows.length }]
  };
}

const idsIn = (state: CustomLogsViewState) => state.page?.rows.map(item => item.id);

test('a capture message sets the strip, and one without a value clears it', () => {
  const shown = reduceCustomLogsView(initialCustomLogsView, { type: 'customLogsCapture', value: LIVE });
  assert.deepEqual(shown.capture, LIVE);

  const cleared = reduceCustomLogsView(shown, { type: 'customLogsCapture' });
  assert.equal(cleared.capture, undefined);
});

test('live rows join the loaded page newest first, and the payload fields of the batch join its summary', () => {
  const state = reduceAll([eventPage([eventRow(30), eventRow(10)]), liveRows([eventRow(20), eventRow(40)])]);

  assert.deepEqual(
    idsIn(state),
    [eventRow(40), eventRow(30), eventRow(20), eventRow(10)].map(item => item.id)
  );
  assert.deepEqual(state.page?.payloadFields, [{ path: 'orderId', types: ['string'], rows: 4 }]);
});

test('live rows never change the columns, which only a page read sets', () => {
  const columns = [{ key: 'A__c', label: 'A' }];
  const state = reduceAll([
    eventPage([eventRow(10)], false, columns),
    liveRows([eventRow(20, { extra: { B__c: 'x' } })])
  ]);

  assert.deepEqual(state.page?.columns, columns);
});

test('live rows before the first page are dropped, because the page read that follows already has them', () => {
  const early = reduceCustomLogsView(initialCustomLogsView, liveRows([eventRow(10)]));
  assert.equal(early, initialCustomLogsView);

  const state = reduceCustomLogsView(early, eventPage([eventRow(10)]));
  assert.deepEqual(idsIn(state), [eventRow(10).id]);
});

test('live rows that are already loaded leave the very same state, so nothing rerenders', () => {
  const loaded = reduceAll([eventPage([eventRow(30), eventRow(20)])]);

  assert.equal(reduceCustomLogsView(loaded, liveRows([eventRow(20), eventRow(30)])), loaded);
  assert.equal(reduceCustomLogsView(loaded, liveRows([])), loaded);
});

test('while more pages follow, a live row older than the loaded rows waits for the page that reads it', () => {
  const firstPage = reduceAll([eventPage([eventRow(30), eventRow(20)], true)]);
  const afterLive = reduceCustomLogsView(firstPage, liveRows([eventRow(25), eventRow(10)]));
  assert.deepEqual(
    idsIn(afterLive),
    [eventRow(30), eventRow(25), eventRow(20)].map(item => item.id)
  );

  const next = reduceCustomLogsView(afterLive, {
    type: 'customLogsPage',
    mode: 'append',
    columns: [],
    rows: [eventRow(15), eventRow(10)],
    payloadFields: [],
    hasMore: false
  });
  assert.deepEqual(
    idsIn(next),
    [eventRow(30), eventRow(25), eventRow(20), eventRow(15), eventRow(10)].map(item => item.id)
  );
});

test('on the last page a live row older than the loaded rows is added at the end', () => {
  const state = reduceAll([eventPage([eventRow(30), eventRow(20)], false), liveRows([eventRow(10)])]);

  assert.deepEqual(
    idsIn(state),
    [eventRow(30), eventRow(20), eventRow(10)].map(item => item.id)
  );
});

test('the replay holds one page message however many live batches arrived, and replays to the same state', () => {
  const batches = Array.from({ length: 50 }, (_, index) =>
    liveRows([eventRow(100 + index * 2), eventRow(101 + index * 2)])
  );
  const messages = [{ type: 'customLogsCapture', value: LIVE } as const, eventPage([eventRow(10)]), ...batches];
  const state = reduceAll(messages);

  const replay = replayCustomLogsView(state);
  assert.equal(replay.filter(message => message.type === 'customLogsPage').length, 1);
  assert.equal(replay.filter(message => message.type === 'customLogsLiveRows').length, 0);
  assert.equal(replay.length, replayCustomLogsView(reduceAll(messages.slice(0, 2))).length);
  assert.deepEqual(reduceAll(replay), state);
  assert.equal(state.page?.rows.length, 101);
});

test('re-delivered live rows do not grow the replay', () => {
  const batch = liveRows([eventRow(40), eventRow(50)]);
  const once = reduceAll([eventPage([eventRow(10)]), batch]);
  const thrice = reduceAll([eventPage([eventRow(10)]), batch, batch, batch]);

  assert.deepEqual(replayCustomLogsView(thrice), replayCustomLogsView(once));
});

test('past the live row cap the provider reloads the newest page, and a replace page brings the rows back down', () => {
  const rows = Array.from({ length: CUSTOM_LOGS_LIVE_ROW_CAP + 1 }, (_, index) => eventRow(1_000 + index));
  const over = reduceAll([eventPage([eventRow(10)], true), liveRows(rows)]);
  assert.ok((over.page?.rows.length ?? 0) > CUSTOM_LOGS_LIVE_ROW_CAP);

  const reloaded = reduceCustomLogsView(over, eventPage(rows.slice(-50).reverse(), true));
  assert.equal(reloaded.page?.rows.length, 50);
  const replayed = replayCustomLogsView(reloaded).find(message => message.type === 'customLogsPage');
  assert.equal(replayed?.type === 'customLogsPage' ? replayed.rows.length : undefined, 50);
});

test('the capture strip replays after the page and before the transient state, and only while there is one', () => {
  const types = (state: CustomLogsViewState) => replayCustomLogsView(state).map(message => message.type);
  const withStrip = reduceAll([eventPage([eventRow(10)]), { type: 'customLogsCapture', value: LIVE }]);

  assert.deepEqual(types(withStrip).slice(-4), [
    'customLogsPage',
    'customLogsCapture',
    'customLogsLoading',
    'customLogsError'
  ]);
  assert.ok(!types(reduceAll([eventPage([eventRow(10)])])).includes('customLogsCapture'));
  assert.ok(!types(reduceCustomLogsView(withStrip, { type: 'customLogsCapture' })).includes('customLogsCapture'));
});

test('replaying any prefix of a capture session gives the same state', () => {
  const session: CustomLogsToWebviewMessage[] = [
    { type: 'customLogsSources', data: [EVENT_SOURCE], selected: 'app-events', issues: [] },
    eventPage([eventRow(10)]),
    { type: 'customLogsCapture', value: { ...LIVE, capture: { state: 'connecting' } } },
    liveRows([eventRow(20)]),
    { type: 'customLogsCapture', value: LIVE },
    liveRows([eventRow(30), eventRow(25)]),
    { type: 'customLogsCapture' }
  ];
  for (let length = 0; length <= session.length; length++) {
    const state = reduceAll(session.slice(0, length));
    assert.deepEqual(reduceAll(replayCustomLogsView(state)), state, `after ${length} messages`);
  }
});

test('folding live rows changes neither the state nor the message it was given', () => {
  const before = reduceAll([eventPage([eventRow(30), eventRow(10)])]);
  const message = liveRows([eventRow(20), eventRow(40)]);
  const snapshot = structuredClone({ before, message });

  reduceCustomLogsView(before, message);

  assert.deepEqual({ before, message }, snapshot);
});
