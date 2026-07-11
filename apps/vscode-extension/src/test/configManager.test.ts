import assert from 'assert/strict';
import proxyquire from 'proxyquire';

function loadConfigManager(values: Record<string, number>) {
  return proxyquire('../host/utils/configManager', {
    './config': {
      getNumberConfig: (name: string, def: number) => values[name] ?? def,
      affectsConfiguration: () => false
    }
  }).ConfigManager as typeof import('../host/utils/configManager').ConfigManager;
}

suite('ConfigManager', () => {
  test('reads head concurrency from electivus namespace on construction', () => {
    const ConfigManager = loadConfigManager({ 'electivus.apexLogViewer.logs.processingConcurrency': 3 });
    const manager = new ConfigManager(5, 100);
    assert.equal(manager.getHeadConcurrency(), 3);
  });

  test('falls back to the constructor default when head concurrency is not configured', () => {
    const ConfigManager = loadConfigManager({});
    const manager = new ConfigManager(7, 100);
    assert.equal(manager.getHeadConcurrency(), 7);
  });
});
