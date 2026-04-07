import assert from 'assert/strict';
import { DEFAULT_LOGS_COLUMNS_CONFIG, normalizeLogsColumnsConfig } from '../shared/logsColumns';

suite('logsColumns config', () => {
  test('normalizes invalid values to defaults', () => {
    const cfg = normalizeLogsColumnsConfig(undefined);
    assert.deepEqual(cfg, DEFAULT_LOGS_COLUMNS_CONFIG);
  });

  test('filters unknown keys and appends missing keys', () => {
    const cfg = normalizeLogsColumnsConfig({ order: ['time', 'nope', 'user', 'time'] });
    assert.equal(cfg.order[0], 'time');
    assert.equal(cfg.order[1], 'user');
    assert.ok(cfg.order.includes('application'));
    assert.ok(cfg.order.includes('match'));
  });

  test('caps inspected order entries for oversized payloads', () => {
    const cfg = normalizeLogsColumnsConfig({
      order: [...Array.from({ length: 1000 }, () => 'nope'), 'time']
    });
    assert.deepEqual(cfg.order, DEFAULT_LOGS_COLUMNS_CONFIG.order);
  });

  test('ignores invalid widths and preserves valid widths', () => {
    const cfg = normalizeLogsColumnsConfig({
      widths: {
        user: -5,
        time: 123.9,
        match: Number.NaN
      }
    });
    assert.equal(cfg.widths.time, 123);
    assert.equal(cfg.widths.user, undefined);
    assert.equal(cfg.widths.match, undefined);
  });
});
