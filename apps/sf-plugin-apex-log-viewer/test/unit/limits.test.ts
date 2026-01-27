import { strict as assert } from 'assert';
import { clampLimit } from '../../src/lib/limits.js';

describe('clampLimit', () => {
  it('clamps to 1..200', () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(201), 200);
    assert.equal(clampLimit(50), 50);
  });
});
