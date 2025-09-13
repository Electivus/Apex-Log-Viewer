import assert from 'assert/strict';
import { LogsMessageHandler } from '../provider/logsMessageHandler';
import type { WebviewToExtensionMessage } from '../shared/messages';

suite('LogsMessageHandler', () => {
  function makeHandler() {
    const calls = {
      refresh: 0,
      sendOrgs: 0,
      setSelectedOrg: [] as (string | undefined)[],
      openLog: [] as string[],
      debugLog: [] as string[],
      loadMore: 0,
      setLoading: [] as boolean[],
    };
    const handler = new LogsMessageHandler(
      async () => {
        calls.refresh++;
      },
      async () => {
        calls.sendOrgs++;
      },
      (org?: string) => {
        calls.setSelectedOrg.push(org);
      },
      async (logId: string) => {
        calls.openLog.push(logId);
      },
      async (logId: string) => {
        calls.debugLog.push(logId);
      },
      async () => {
        calls.loadMore++;
      },
      (val: boolean) => {
        calls.setLoading.push(val);
      }
    );
    return { handler, calls };
  }

  test('handles ready message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'ready' } as WebviewToExtensionMessage);
    assert.deepStrictEqual(calls.setLoading, [true, false]);
    assert.equal(calls.sendOrgs, 1);
    assert.equal(calls.refresh, 1);
  });

  test('handles selectOrg message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'selectOrg', target: ' foo ' } as WebviewToExtensionMessage);
    assert.deepStrictEqual(calls.setSelectedOrg, ['foo']);
    assert.equal(calls.refresh, 1);
  });

  test('handles loadMore message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'loadMore' } as WebviewToExtensionMessage);
    assert.equal(calls.loadMore, 1);
  });

  test('handles openLog message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'openLog', logId: '123' } as WebviewToExtensionMessage);
    assert.deepStrictEqual(calls.openLog, ['123']);
  });

  test('handles replay message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'replay', logId: 'xyz' } as WebviewToExtensionMessage);
    assert.deepStrictEqual(calls.debugLog, ['xyz']);
  });

  test('handles getOrgs message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'getOrgs' } as WebviewToExtensionMessage);
    assert.deepStrictEqual(calls.setLoading, [true, false]);
    assert.equal(calls.sendOrgs, 1);
  });

  test('handles refresh message', async () => {
    const { handler, calls } = makeHandler();
    await handler.handle({ type: 'refresh' } as WebviewToExtensionMessage);
    assert.equal(calls.refresh, 1);
  });
});

