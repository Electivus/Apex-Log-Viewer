import assert from 'assert/strict';
import { formatDuration } from '../shared/format';

suite('formatDuration', () => {
  test('formats milliseconds under one second', () => {
    assert.equal(formatDuration(0), '0 ms');
    assert.equal(formatDuration(1), '1 ms');
    assert.equal(formatDuration(999), '999 ms');
  });

  test('formats in seconds', () => {
    assert.equal(formatDuration(1000), '1 s');
    assert.equal(formatDuration(1530), '1.5 s');
    assert.equal(formatDuration(59_500), '59.5 s');
  });

  test('formats in minutes', () => {
    assert.equal(formatDuration(60_000), '1 min');
    assert.equal(formatDuration(90_000), '1.5 min');
  });

  test('formats in hours', () => {
    assert.equal(formatDuration(3_600_000), '1 h');
    assert.equal(formatDuration(5_400_000), '1.5 h');
  });

  test('formats in days', () => {
    assert.equal(formatDuration(86_400_000), '1 d');
    assert.equal(formatDuration(129_600_000), '1.5 d');
  });
});
