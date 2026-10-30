import assert from 'node:assert/strict';
import test from 'node:test';

import type { CustomLogsToWebviewMessage } from '../src/customLogsMessages.ts';
import {
  initialCustomLogsView,
  reduceCustomLogsView,
  replayCustomLogsView,
  type CustomLogsViewState
} from '../src/customLogsState.ts';
import type { CustomLogRow, CustomLogSourceView } from '../src/customLogsTypes.ts';

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
