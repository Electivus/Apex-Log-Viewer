import assert from 'assert/strict';
import { parseDebugFlagsFromWebviewMessage } from '../shared/debugFlagsMessages';
import { parseLogViewerFromWebviewMessage } from '../shared/logViewerMessages';
import { parseWebviewToExtensionMessage } from '../shared/messages';

suite('webview message validation', () => {
  test('accepts safe logs webview messages and rejects malformed payloads', () => {
    assert.deepEqual(parseWebviewToExtensionMessage({ type: 'openLog', logId: '07L000000000001AA' }), {
      type: 'openLog',
      logId: '07L000000000001AA'
    });
    assert.equal(parseWebviewToExtensionMessage({ type: 'openLog', logId: { bad: true } } as any), undefined);
    assert.equal(parseWebviewToExtensionMessage({ type: 'searchQuery', value: 'x'.repeat(5000) }), undefined);
  });

  test('accepts safe debug flags messages and rejects invalid targets or ttl values', () => {
    assert.deepEqual(
      parseDebugFlagsFromWebviewMessage({
        type: 'debugFlagsApply',
        target: { type: 'user', userId: '005000000000001AAA' },
        debugLevelName: 'SFDC_DevConsole',
        ttlMinutes: 30
      }),
      {
        type: 'debugFlagsApply',
        target: { type: 'user', userId: '005000000000001AAA' },
        debugLevelName: 'SFDC_DevConsole',
        ttlMinutes: 30
      }
    );
    assert.equal(
      parseDebugFlagsFromWebviewMessage({
        type: 'debugFlagsApply',
        target: { type: 'user' },
        debugLevelName: 'SFDC_DevConsole',
        ttlMinutes: 30
      } as any),
      undefined
    );
    assert.equal(
      parseDebugFlagsFromWebviewMessage({
        type: 'debugFlagsApply',
        target: { type: 'user', userId: '005000000000001AAA' },
        debugLevelName: 'SFDC_DevConsole',
        ttlMinutes: 0
      } as any),
      undefined
    );
  });

  test('rejects oversized log viewer copy payloads', () => {
    assert.equal(
      parseLogViewerFromWebviewMessage({ type: 'logViewerCopyText', text: 'x'.repeat(1_000_001) }),
      undefined
    );
  });
});
