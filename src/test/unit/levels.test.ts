import { strict as assert } from 'assert';
import { parseDefaultLogLevels } from '../../shared/apexLogParser/levels';

suite('parseDefaultLogLevels', () => {
  test('parses valid levels from head lines', () => {
    const head = ['64.0 APEX_CODE,FINEST;DB,INFO;SYSTEM,DEBUG'];
    const levels = parseDefaultLogLevels(head);
    assert.deepEqual(levels, { APEX_CODE: 'FINEST', DB: 'INFO', SYSTEM: 'DEBUG' });
  });

  test('returns undefined when head is missing', () => {
    const levels = parseDefaultLogLevels(['Some other line']);
    assert.equal(levels, undefined);
  });

  test('handles partially specified levels', () => {
    const head = ['APEX_CODE,', 'DB,INFO'];
    const levels = parseDefaultLogLevels(head);
    assert.equal(levels, undefined);
  });
});
