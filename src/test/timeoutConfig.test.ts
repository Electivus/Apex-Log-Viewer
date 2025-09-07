import assert from 'assert/strict';
import { workspace } from 'vscode';
import { getCliTimeoutMs } from '../salesforce/cli';
import { getHttpTimeoutMs } from '../salesforce/http';

suite('timeout settings', () => {
  const original = workspace.getConfiguration;

  teardown(() => {
    (workspace.getConfiguration as any) = original;
  });

  test('CLI timeout clamped to range', () => {
    (workspace.getConfiguration as any) = () => ({ get: () => 5 });
    assert.equal(getCliTimeoutMs(), 1000);
    (workspace.getConfiguration as any) = () => ({ get: () => 9999999 });
    assert.equal(getCliTimeoutMs(), 600000);
  });

  test('HTTP timeout clamped to range', () => {
    (workspace.getConfiguration as any) = () => ({ get: () => 5 });
    assert.equal(getHttpTimeoutMs(), 1000);
    (workspace.getConfiguration as any) = () => ({ get: () => 9999999 });
    assert.equal(getHttpTimeoutMs(), 600000);
  });
});
