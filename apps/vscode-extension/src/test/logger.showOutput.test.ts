import assert from 'assert/strict';
import proxyquire from 'proxyquire';

suite('logger showOutput', () => {
  test('reveals output channel', () => {
    let preserve: boolean | undefined;
    const { showOutput } = proxyquire('../../../../src/utils/logger', {
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
});
