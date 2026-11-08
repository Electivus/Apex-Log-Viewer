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

    await store.write('app-log', ['http.status']);
    await store.write('nebula', ['orderId']);

    assert.deepEqual(store.read('app-log', []), { defaults: [], added: ['http.status'] });
    assert.deepEqual(store.read('nebula', []), { defaults: [], added: ['orderId'] });
    assert.deepEqual(store.read('other', []), { defaults: [], added: [] });
    assert.deepEqual(memento.values.get(KEY), { 'entry:app-log': ['http.status'], 'entry:nebula': ['orderId'] });
  });

  test('leaves the header lists an older build stored alone', async () => {
    const memento = createMemento({ [KEY]: { 'transaction:nebula': ['customer.tier'] } });
    const store = createPayloadColumnsStore(memento);

    await store.write('nebula', ['orderId']);

    assert.deepEqual(store.read('nebula', []), { defaults: [], added: ['orderId'] });
    assert.deepEqual(memento.values.get(KEY), {
      'transaction:nebula': ['customer.tier'],
      'entry:nebula': ['orderId']
    });
  });

  test('never shows a default twice', async () => {
    const store = createPayloadColumnsStore(createMemento());
    await store.write('app-log', ['orderId', 'http.status']);

    assert.deepEqual(store.read('app-log', ['orderId']), { defaults: ['orderId'], added: ['http.status'] });
  });

  test('an empty list forgets the source', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);
    await store.write('app-log', ['orderId']);

    await store.write('app-log', []);

    assert.deepEqual(memento.values.get(KEY), {});
  });

  test('ignores a malformed list instead of storing it', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);

    await store.write('app-log', ['ok', '  padded ']);
    await store.write(
      'app-log',
      Array.from({ length: 51 }, (_, index) => `path${index}`)
    );

    assert.equal(memento.values.has(KEY), false);
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
      await store.write(`source-${index}`, ['a']);
    }

    assert.equal(Object.keys(memento.values.get(KEY) as object).length, 100);
    assert.deepEqual(store.read('source-0', []).added, []);
    assert.deepEqual(store.read('source-100', []).added, ['a']);
  });
});
