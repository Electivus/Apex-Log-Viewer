import assert from 'assert/strict';
import { formatBytes } from '../shared/format';

suite('formatBytes', () => {
  test('formats bytes under 1 KB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  test('formats in KB', () => {
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB'); // 1.5 KB
    assert.equal(formatBytes(10 * 1024), '10 KB');
  });

  test('formats in MB', () => {
    assert.equal(formatBytes(1024 * 1024), '1 MB');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
    assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  });

  test('formats in GB', () => {
    assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB');
    assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
    assert.equal(formatBytes(5 * 1024 * 1024 * 1024), '5 GB');
  });
});
