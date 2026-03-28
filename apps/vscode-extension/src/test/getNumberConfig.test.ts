import assert from 'assert/strict';
import proxyquire from 'proxyquire';

function loadGetNumberConfig(getter: (key: string) => unknown) {
  return proxyquire('../../../../src/utils/config', {
    vscode: {
      workspace: {
        getConfiguration: () => ({
          get: getter
        })
      }
    }
  }).getNumberConfig as typeof import('../../../../src/utils/config').getNumberConfig;
}

suite('getNumberConfig', () => {
  test('clamps to minimum value', () => {
    const getNumberConfig = loadGetNumberConfig(() => 5);
    const n = getNumberConfig('test.min', 10, 10, 20);
    assert.equal(n, 10);
  });

  test('clamps to maximum value', () => {
    const getNumberConfig = loadGetNumberConfig(() => 30);
    const n = getNumberConfig('test.max', 10, 1, 20);
    assert.equal(n, 20);
  });
});
