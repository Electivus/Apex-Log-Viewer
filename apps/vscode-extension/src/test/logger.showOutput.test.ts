import assert from 'assert/strict';
import proxyquire from 'proxyquire';

suite('logger showOutput', () => {
  test('reveals output channel', () => {
    let preserve: boolean | undefined;
    const { showOutput } = proxyquire('../host/utils/logger', {
      vscode: {
        window: {
          createOutputChannel: () => ({
            info: () => {},
            warn: () => {},
            error: () => {},
            trace: () => {},
            show: (p?: boolean) => {
              preserve = p;
            },
            dispose: () => {}
          })
        }
      },
      './error': {
        stringifyUnknown: (value: unknown) => String(value)
      }
    });

    showOutput(true);
    assert.strictEqual(preserve, true, 'channel.show should be invoked');
  });

  test('redacts token-shaped log values from recent diagnostic entries', () => {
    const { getRecentLogEntries, logInfo } = proxyquire('../host/utils/logger', {
      vscode: {
        window: {
          createOutputChannel: () => ({
            info: () => {},
            warn: () => {},
            error: () => {},
            trace: () => {},
            show: () => {},
            dispose: () => {}
          })
        }
      }
    });

    logInfo('Authorization: Bearer 00Dxx000000000001!secret-token', {
      accessToken: 'raw-access-token',
      refresh_token: 'raw-refresh-token',
      sessionId: 'raw-session-id'
    });

    const recent = getRecentLogEntries();
    const message = recent.at(-1)?.message ?? '';

    assert.equal(message.includes('00Dxx000000000001!secret-token'), false);
    assert.equal(message.includes('raw-access-token'), false);
    assert.equal(message.includes('raw-refresh-token'), false);
    assert.equal(message.includes('raw-session-id'), false);
    assert.ok(message.includes('[redacted]'), 'sanitized log should keep redaction markers');
  });
});
