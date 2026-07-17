import assert from 'node:assert/strict';

import { buildRipgrepSearchArgs } from '../../../host/utils/ripgrep';

suite('ripgrep log search', () => {
  test('searches the managed apexlogs cache even when gitignored', () => {
    const args = buildRipgrepSearchArgs('STATEMENT_EXECUT');

    assert.ok(args.includes('--no-ignore'));
    assert.deepEqual(args.slice(-3), ['--', 'STATEMENT_EXECUT', '.']);
  });
});
