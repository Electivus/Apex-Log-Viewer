import assert from 'assert/strict';
import { workspace } from 'vscode';
import { getNumberConfig } from '../utils/config';

suite('getNumberConfig', () => {
  const originalGetConfiguration = workspace.getConfiguration;

  teardown(() => {
    (workspace.getConfiguration as any) = originalGetConfiguration;
  });

  test('clamps to minimum value', () => {
    (workspace.getConfiguration as any) = () => ({ get: () => 5 });
    const n = getNumberConfig('test.min', 10, 10, 20);
    assert.equal(n, 10);
  });

  test('clamps to maximum value', () => {
    (workspace.getConfiguration as any) = () => ({ get: () => 30 });
    const n = getNumberConfig('test.max', 10, 1, 20);
    assert.equal(n, 20);
  });
});
