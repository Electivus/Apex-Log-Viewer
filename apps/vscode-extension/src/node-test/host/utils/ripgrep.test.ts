import assert from 'node:assert/strict';

import { buildRipgrepFileSearchArgs, buildRipgrepSearchArgs } from '../../../host/utils/ripgrep';

suite('ripgrep log search', () => {
  test('searches the managed apexlogs cache even when gitignored', () => {
    const args = buildRipgrepSearchArgs('STATEMENT_EXECUT');

    assert.ok(args.includes('--no-ignore'));
    assert.deepEqual(args.slice(-3), ['--', 'STATEMENT_EXECUT', '.']);
  });

  test('searches only lifecycle-approved local files', () => {
    const files = ['/workspace/apexlogs/orgs/one/logs/2026-07-20/one.log', '/workspace/path with spaces/two.log'];
    const args = buildRipgrepFileSearchArgs('FATAL_ERROR', files);

    assert.deepEqual(args.slice(-4), ['--', 'FATAL_ERROR', ...files]);
  });
});
