import assert from 'assert/strict';
import { renderHook } from '@testing-library/react';
import { useVsCodeMessages } from '../webview/utils/useVsCodeMessages';

type Outgoing = { type: 'out'; };
type Incoming = { type: 'in'; };

suite('useVsCodeMessages', () => {
  test('dispatches messages', async () => {
    const sent: Outgoing[] = [];
    (globalThis as any).acquireVsCodeApi = () => ({
      postMessage: (msg: Outgoing) => {
        sent.push(msg);
      },
      getState: () => undefined,
      setState: () => {}
    });

    const { result } = renderHook(() => useVsCodeMessages<Outgoing, Incoming>());
    const received: Incoming[] = [];
    const dispose = result.current.addMessageListener(msg => received.push(msg));

    result.current.postMessage({ type: 'out' });
    assert.deepEqual(sent, [{ type: 'out' }]);

    window.postMessage({ type: 'in' }, '*');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(received, [{ type: 'in' }]);

    dispose();
  });
});
