import assert from 'node:assert/strict';

import {
  CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY as KEY,
  createPayloadColumnsStore
} from '../../provider/customLogsPayloadColumns';
import { createMemento } from '../customLogsTestSupport';

suite('Custom Logs payload column store', () => {
  test('keeps the added columns apart per source and per level', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);

    await store.write('app-log', 'entry', ['http.status']);
    await store.write('nebula', 'transaction', ['customer.tier']);
    await store.write('nebula', 'entry', ['orderId']);

    assert.deepEqual(store.read('app-log', 'entry', []), { defaults: [], added: ['http.status'] });
    assert.deepEqual(store.read('nebula', 'transaction', []), { defaults: [], added: ['customer.tier'] });
    assert.deepEqual(store.read('nebula', 'entry', []), { defaults: [], added: ['orderId'] });
    assert.deepEqual(store.read('other', 'entry', []), { defaults: [], added: [] });
  });

  test('never shows a default twice', async () => {
    const store = createPayloadColumnsStore(createMemento());
    await store.write('app-log', 'entry', ['orderId', 'http.status']);

    assert.deepEqual(store.read('app-log', 'entry', ['orderId']), { defaults: ['orderId'], added: ['http.status'] });
  });

  test('an empty list forgets the source', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);
    await store.write('app-log', 'entry', ['orderId']);

    await store.write('app-log', 'entry', []);

    assert.deepEqual(memento.values.get(KEY), {});
  });

  test('ignores a malformed list instead of storing it', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);

    await store.write('app-log', 'entry', ['ok', '  padded ']);
    await store.write(
      'app-log',
      'entry',
      Array.from({ length: 51 }, (_, index) => `path${index}`)
    );

    assert.equal(memento.values.has(KEY), false);
  });

  test('reads around hand-edited state', () => {
    const memento = createMemento({ [KEY]: { 'entry:good': ['a.b'], 'entry:bad': [1, 2], 'entry:long': 'text' } });
    const store = createPayloadColumnsStore(memento);

    assert.deepEqual(store.read('good', 'entry', []), { defaults: [], added: ['a.b'] });
    assert.deepEqual(store.read('bad', 'entry', []), { defaults: [], added: [] });
    assert.deepEqual(store.read('long', 'entry', []), { defaults: [], added: [] });
    assert.deepEqual(
      createPayloadColumnsStore(createMemento({ [KEY]: ['not', 'a', 'record'] })).read('x', 'entry', []),
      {
        defaults: [],
        added: []
      }
    );
  });

  test('forgets the oldest list past the cap', async () => {
    const memento = createMemento();
    const store = createPayloadColumnsStore(memento);
    for (let index = 0; index < 101; index += 1) {
      await store.write(`source-${index}`, 'entry', ['a']);
    }

    assert.equal(Object.keys(memento.values.get(KEY) as object).length, 100);
    assert.deepEqual(store.read('source-0', 'entry', []).added, []);
    assert.deepEqual(store.read('source-100', 'entry', []).added, ['a']);
  });
});
