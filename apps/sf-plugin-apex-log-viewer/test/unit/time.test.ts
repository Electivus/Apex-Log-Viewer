import { strict as assert } from 'assert';
import { formatStartTimeUtc } from '../../src/lib/time.js';

describe('formatStartTimeUtc', () => {
  it('formats StartTime to YYYYMMDDTHHmmssZ', () => {
    const out = formatStartTimeUtc('2024-01-02T03:04:05.000+0000');
    assert.equal(out, '20240102T030405Z');
  });
});
