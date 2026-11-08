import assert from 'node:assert/strict';

import {
  CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY as KEY,
  createPayloadColumnsStore
} from '../../provider/customLogsPayloadColumns';
import { createMemento } from '../customLogsTestSupport';

suite('Custom Logs payload column store', () => {
  test('keeps the added columns apart per source', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);

    await store.show('app-log', 'http.status', true);
    await store.show('nebula', 'orderId', true);

    assert.deepEqual(store.read('app-log', []), { defaults: [], added: ['http.status'] });
    assert.deepEqual(store.read('nebula', []), { defaults: [], added: ['orderId'] });
    assert.deepEqual(store.read('other', []), { defaults: [], added: [] });
    assert.deepEqual(memento.values.get(KEY), { 'entry:app-log': ['http.status'], 'entry:nebula': ['orderId'] });
  });

  test('leaves the header lists an older build stored alone', async () => {
    const memento = createMemento({ [KEY]: { 'transaction:nebula': ['customer.tier'] } });
    const store = createPayloadColumnsStore(memento);

    await store.show('nebula', 'orderId', true);

    assert.deepEqual(store.read('nebula', []), { defaults: [], added: ['orderId'] });
    assert.deepEqual(memento.values.get(KEY), {
      'transaction:nebula': ['customer.tier'],
      'entry:nebula': ['orderId']
    });
  });

  test('the same change twice is the change once', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);

    await store.show('app-log', 'http.status', true);
    await store.show('app-log', 'http.status', true);
    await store.show('app-log', 'orderId', true);
    await store.show('app-log', 'orderId', false);
    await store.show('app-log', 'orderId', false);

    assert.deepEqual(memento.values.get(KEY), { 'entry:app-log': ['http.status'] });
  });

  test("two surfaces over one workspace keep each other's columns", async () => {
    const memento = createMemento();
    const list = createPayloadColumnsStore(memento);
    const viewer = createPayloadColumnsStore(memento);

    await Promise.all([list.show('nebula', 'http.status', true), viewer.show('nebula', 'traceId', true)]);
    await Promise.all([list.show('nebula', 'orderId', true), viewer.show('nebula', 'http.status', false)]);

    assert.deepEqual(list.read('nebula', []).added, ['traceId', 'orderId']);
    assert.deepEqual(viewer.read('nebula', []).added, ['traceId', 'orderId']);
  });

  test('never shows a default twice', async () => {
    const store = createPayloadColumnsStore(createMemento());
    await store.show('app-log', 'orderId', true);
    await store.show('app-log', 'http.status', true);

    assert.deepEqual(store.read('app-log', ['orderId']), { defaults: ['orderId'], added: ['http.status'] });
  });

  test('hiding the last column forgets the source', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);
    await store.show('app-log', 'orderId', true);

    await store.show('app-log', 'orderId', false);

    assert.deepEqual(memento.values.get(KEY), {});
  });

  test('stores no 51st column', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);
    for (let index = 0; index < 51; index += 1) {
      await store.show('app-log', `path${index}`, true);
    }

    assert.equal(store.read('app-log', []).added.length, 50);
    assert.equal(store.read('app-log', []).added.includes('path50'), false);
  });

  test('reads around hand-edited state', () => {
    const memento = createMemento({ [KEY]: { 'entry:good': ['a.b'], 'entry:bad': [1, 2], 'entry:long': 'text' } });
    const store = createPayloadColumnsStore(memento);

    assert.deepEqual(store.read('good', []), { defaults: [], added: ['a.b'] });
    assert.deepEqual(store.read('bad', []), { defaults: [], added: [] });
    assert.deepEqual(store.read('long', []), { defaults: [], added: [] });
    assert.deepEqual(createPayloadColumnsStore(createMemento({ [KEY]: ['not', 'a', 'record'] })).read('x', []), {
      defaults: [],
      added: []
    });
  });

  test('forgets the oldest list past the cap', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);
    for (let index = 0; index < 101; index += 1) {
      await store.show(`source-${index}`, 'a', true);
    }

    assert.equal(Object.keys(memento.values.get(KEY) as object).length, 100);
    assert.deepEqual(store.read('source-0', []).added, []);
    assert.deepEqual(store.read('source-100', []).added, ['a']);
  });
});
