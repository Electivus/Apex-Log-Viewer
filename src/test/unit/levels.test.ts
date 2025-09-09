import assert from 'assert/strict';
import { parseDefaultLogLevels } from '../../shared/apexLogParser/levels';

suite('parseDefaultLogLevels', () => {
  test('parses levels from a typical header line', () => {
    const head = ['64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;DB,INFO;SYSTEM,DEBUG'];
    const levels = parseDefaultLogLevels(head);
    assert.deepEqual(levels, {
      APEX_CODE: 'FINEST',
      APEX_PROFILING: 'INFO',
      DB: 'INFO',
      SYSTEM: 'DEBUG'
    });
  });

  test('returns undefined if no APEX_CODE line is present', () => {
    const levels = parseDefaultLogLevels(['Some other line', 'RANDOM']);
    assert.equal(levels, undefined);
  });

  test('ignores invalid/partial categories and may return undefined', () => {
    // First line contains APEX_CODE but no valid value; second line is ignored by design
    const levels = parseDefaultLogLevels(['APEX_CODE,', 'DB,INFO']);
    assert.equal(levels, undefined);
  });
});

