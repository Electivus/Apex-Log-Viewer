import assert from 'node:assert/strict';

import {
  CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY as KEY,
  createPayloadColumnsStore
} from '../../provider/customLogsPayloadColumns';
import { createMemento } from '../customLogsTestSupport';

suite('Custom Logs payload column store', () => {
  test('a listener can add a column without losing the change that notified it', async () => {
    const store = createPayloadColumnsStore(createMemento());
    const writes: Array<Promise<void>> = [];
    const seen: string[][] = [];
    store.onDidChange(sourceId => {
      if (!store.read(sourceId, []).added.includes('traceId')) {
        writes.push(store.show(sourceId, 'traceId', true));
      }
    });
    store.onDidChange(sourceId => seen.push(store.read(sourceId, []).added));

    await store.show('nebula', 'orderId', true);
    await Promise.all(writes);

    assert.deepEqual(seen, [
      ['orderId', 'traceId'],
      ['orderId', 'traceId']
    ]);
    assert.deepEqual(store.read('nebula', []).added, ['orderId', 'traceId']);
  });

  test('snapshots listeners for delivery and unsubscribes only the disposed consumer', async () => {
    const store = createPayloadColumnsStore(createMemento());
    const seen: string[] = [];
    const late = () => seen.push('late');
    const first = store.onDidChange(() => {
      seen.push('first');
      second.dispose();
      store.onDidChange(late);
    });
    const second = store.onDidChange(() => seen.push('second'));

    await store.show('nebula', 'orderId', true);
    assert.deepEqual(seen, ['first', 'second']);
    first.dispose();
    first.dispose();
    seen.length = 0;
    await store.show('nebula', 'traceId', true);
    assert.deepEqual(seen, ['late']);
  });

  test('notifies an identical retry after persistence fails with the cache already updated', async () => {
    const memento = createMemento();
    const failure = new Error('workspace state failed');
    let fail = true;
    memento.update = async (key, value) => {
      memento.values.set(key, value);
      if (fail) {
        throw failure;
      }
    };
    const store = createPayloadColumnsStore(memento);
    const seen: string[][] = [];
    store.onDidChange(sourceId => seen.push(store.read(sourceId, []).added));

    await assert.rejects(store.show('nebula', 'http.status', true), failure);
    assert.deepEqual(store.read('nebula', []).added, ['http.status']);
    assert.deepEqual(seen, []);
    await assert.rejects(store.show('nebula', 'http.status', true), failure);
    fail = false;
    await store.show('nebula', 'http.status', true);
    assert.deepEqual(seen, [['http.status']]);
    await store.show('nebula', 'http.status', true);
    assert.deepEqual(seen, [['http.status']], 'an acknowledged no-op stays silent');
  });

  test('recovers eviction invalidations on the next successful save of another source', async () => {
    const memento = createMemento({
      [KEY]: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`entry:source-${index}`, ['a']]))
    });
    const failure = new Error('workspace state failed');
    let fail = true;
    memento.update = async (key, value) => {
      memento.values.set(key, value);
      if (fail) {
        throw failure;
      }
    };
    const store = createPayloadColumnsStore(memento);
    const seen: Array<[string, string[]]> = [];
    store.onDidChange(sourceId => seen.push([sourceId, store.read(sourceId, []).added]));

    await assert.rejects(store.show('source-100', 'a', true), failure);
    assert.deepEqual(store.read('source-0', []).added, []);
    assert.deepEqual(seen, []);
    fail = false;
    await store.show('source-99', 'a', true);
    assert.deepEqual(seen, [
      ['source-100', ['a']],
      ['source-0', []]
    ]);
    await store.show('source-100', 'a', true);
    assert.equal(seen.length, 2);
  });

  for (const failFirst of [false, true]) {
    test(`an older success preserves a newer failed invalidation when failure settles ${failFirst ? 'first' : 'last'}`, async () => {
      const memento = createMemento();
      const saves: Array<{ resolve(): void; reject(error: Error): void }> = [];
      memento.update = (key, value) => {
        memento.values.set(key, value);
        return new Promise<void>((resolve, reject) => saves.push({ resolve, reject }));
      };
      const store = createPayloadColumnsStore(memento);
      const seen: string[][] = [];
      store.onDidChange(sourceId => seen.push(store.read(sourceId, []).added));
      const first = store.show('nebula', 'orderId', true);
      const second = store.show('nebula', 'traceId', true);
      const failure = new Error('workspace state failed');
      const rejected = assert.rejects(second, failure);

      if (failFirst) {
        saves[1]!.reject(failure);
        await rejected;
      }
      saves[0]!.resolve();
      await first;
      if (!failFirst) {
        saves[1]!.reject(failure);
        await rejected;
      }
      assert.deepEqual(seen, [['orderId', 'traceId']]);
      const retry = store.show('nebula', 'traceId', true);
      saves[2]!.resolve();
      await retry;
      assert.deepEqual(seen, [
        ['orderId', 'traceId'],
        ['orderId', 'traceId']
      ]);
      const noOp = store.show('nebula', 'traceId', true);
      saves[3]!.resolve();
      await noOp;
      assert.equal(seen.length, 2);
    });
  }

  test('merges before awaiting persistence and rereads current columns when writes settle out of order', async () => {
    const memento = createMemento();
    const releases: Array<() => void> = [];
    memento.update = (key, value) => {
      memento.values.set(key, value);
      return new Promise<void>(resolve => releases.push(resolve));
    };
    const list = createPayloadColumnsStore(memento);
    const viewer = createPayloadColumnsStore(memento);
    const seen: string[][] = [];
    viewer.onDidChange(sourceId => seen.push(viewer.read(sourceId, []).added));

    const first = list.show('nebula', 'orderId', true);
    const second = viewer.show('nebula', 'traceId', true);
    assert.deepEqual(memento.values.get(KEY), { 'entry:nebula': ['orderId', 'traceId'] });
    assert.deepEqual(seen, [], 'no notification precedes successful persistence');
    releases[1]!();
    await second;
    releases[0]!();
    await first;

    assert.deepEqual(seen, [
      ['orderId', 'traceId'],
      ['orderId', 'traceId']
    ]);
  });

  test('reports a failing listener without rejecting a saved change or skipping other consumers', async () => {
    const store = createPayloadColumnsStore(createMemento());
    const failure = new Error('consumer failed');
    const changed: string[] = [];
    const reported: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void reported.push(args);
    store.onDidChange(() => {
      throw failure;
    });
    store.onDidChange(sourceId => changed.push(sourceId));

    try {
      await store.show('nebula', 'orderId', true);
      assert.deepEqual(changed, ['nebula']);
      assert.equal(reported.length, 1);
      assert.ok(reported[0]?.includes(failure));
      assert.deepEqual(store.read('nebula', []).added, ['orderId']);
    } finally {
      console.error = original;
    }
  });

  test('notifies separate factory consumers only when their workspace columns change', async () => {
    const memento = createMemento({ [KEY]: { 'entry:nebula': [] } });
    const writer = createPayloadColumnsStore(memento);
    const reader = createPayloadColumnsStore(memento);
    const otherWorkspace = createPayloadColumnsStore(createMemento());
    const changed: string[] = [];
    const unrelated: string[] = [];
    reader.onDidChange(sourceId => changed.push(sourceId));
    otherWorkspace.onDidChange(sourceId => unrelated.push(sourceId));

    await writer.show('nebula', 'missing', false);
    await writer.show('nebula', 'orderId', true);
    await writer.show('nebula', 'orderId', true);
    await writer.show('nebula', 'missing', false);
    await writer.show('nebula', '', true);
    await writer.show('app-log', 'http.status', true);

    assert.deepEqual(changed, ['nebula', 'app-log']);
    assert.deepEqual(unrelated, []);
    assert.deepEqual(reader.read('nebula', ['orderId']), { defaults: ['orderId'], added: [] });
    assert.deepEqual(reader.read('nebula', ['traceId']), { defaults: ['traceId'], added: ['orderId'] });
  });

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
    for (let index = 0; index < 100; index += 1) {
      await store.show(`source-${index}`, 'a', true);
    }
    const changed: string[] = [];
    store.onDidChange(sourceId => changed.push(sourceId));

    await store.show('source-100', 'a', true);

    assert.equal(Object.keys(memento.values.get(KEY) as object).length, 100);
    assert.deepEqual(store.read('source-0', []).added, []);
    assert.deepEqual(store.read('source-100', []).added, ['a']);
    assert.deepEqual(changed.sort(), ['source-0', 'source-100']);
  });
});
