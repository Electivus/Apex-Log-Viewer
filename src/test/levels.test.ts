import assert from 'assert/strict';
import { parseDefaultLogLevels } from '../shared/apexLogParser/levels';

suite('parseDefaultLogLevels', () => {
  test('parses default log levels from head lines', () => {
    const head = ['64.0 APEX_CODE,FINEST;DB,INFO;SYSTEM,DEBUG;'];
    const levels = parseDefaultLogLevels(head);
    assert.deepEqual(levels, { APEX_CODE: 'FINEST', DB: 'INFO', SYSTEM: 'DEBUG' });
  });

  test('returns undefined when no log level line is present', () => {
    const head = ['Some other line', 'Another line'];
    const levels = parseDefaultLogLevels(head);
    assert.equal(levels, undefined);
  });
});
