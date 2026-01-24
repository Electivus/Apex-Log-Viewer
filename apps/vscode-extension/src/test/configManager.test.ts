import assert from 'assert/strict';
import { workspace } from 'vscode';
import { ConfigManager } from '../utils/configManager';

suite('ConfigManager', () => {
  const originalGetConfiguration = workspace.getConfiguration;

  teardown(() => {
    (workspace.getConfiguration as any) = originalGetConfiguration;
  });

  test('reads head concurrency from electivus namespace on construction', () => {
    const values = new Map<string, unknown>([['electivus.apexLogs.headConcurrency', 3]]);
    (workspace.getConfiguration as any) = () => ({
      get: (key: string) => values.get(key)
    });

    const manager = new ConfigManager(5, 100);

    assert.equal(manager.getHeadConcurrency(), 3);
  });

  test('falls back to legacy namespace for head concurrency', () => {
    const values = new Map<string, unknown>([['sfLogs.headConcurrency', 7]]);
    (workspace.getConfiguration as any) = () => ({
      get: (key: string) => values.get(key)
    });

    const manager = new ConfigManager(5, 100);

    assert.equal(manager.getHeadConcurrency(), 7);
  });
});
