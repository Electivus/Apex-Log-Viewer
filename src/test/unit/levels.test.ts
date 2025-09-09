import assert from 'assert/strict';
import { parseDefaultLogLevels } from '../../shared/apexLogParser/levels';

suite('parseDefaultLogLevels', () => {
  test('parses valid header line', () => {
    const lines = ['64.0 APEX_CODE,FINEST;DB,INFO;SYSTEM,DEBUG;'];
    const levels = parseDefaultLogLevels(lines);
    assert.deepEqual(levels, { APEX_CODE: 'FINEST', DB: 'INFO', SYSTEM: 'DEBUG' });
  });

  test('returns undefined when header missing', () => {
    const lines = ['Some other line', 'Another line'];
    const levels = parseDefaultLogLevels(lines);
    assert.equal(levels, undefined);
  });
});
