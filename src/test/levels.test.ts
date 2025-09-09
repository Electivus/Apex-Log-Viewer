import assert from 'assert/strict';
import { parseDefaultLogLevels } from '../shared/apexLogParser/levels';

suite('parseDefaultLogLevels', () => {
  test('parses levels from header line', () => {
    const head = ['64.0 APEX_CODE,FINEST;DB,INFO;SYSTEM,DEBUG;'];
    const levels = parseDefaultLogLevels(head);
    assert.deepEqual(levels, { APEX_CODE: 'FINEST', DB: 'INFO', SYSTEM: 'DEBUG' });
  });

  test('returns undefined for incomplete logs', () => {
    const head = ['No level info here'];
    const levels = parseDefaultLogLevels(head);
    assert.equal(levels, undefined);
  });
});
