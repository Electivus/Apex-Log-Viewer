import { strict as assert } from 'assert';
import { runWithConcurrency } from '../../src/lib/concurrency.js';

describe('runWithConcurrency', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    await runWithConcurrency(items, 2, async (n: number) => {
      seen.push(n);
    });
    assert.deepEqual(seen.sort(), items);
  });
});
