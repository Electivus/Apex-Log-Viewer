import assert from 'assert/strict';
import { parseLogLines } from '../webview/utils/logViewerParser';

suite('logViewerParser', () => {
  test('parses mixed log lines into structured entries', () => {
    const lines = [
      '12:00:00.000 | USER_DEBUG | [42] | Debug message | Extra detail',
      '13:00:00.000 (5) | SOQL_EXECUTE_BEGIN | [3] | Query context | SELECT Id FROM Account',
      '14:00:00.000 | DML_UPDATE | Account | update Account:1',
      '15:00:00.000 | CODE_UNIT_STARTED | [10] | Trigger:AccountUpdate | Handler.init',
      '16:00:00.000 | LIMIT_USAGE | Limit info',
      '17:00:00.000 | METHOD_ENTRY | enter',
      'Loose log without separators'
    ];

    const parsed = parseLogLines(lines);
    assert.equal(parsed.length, 7);

    const debugEntry = parsed[0]!;
    assert.equal(debugEntry.category, 'debug');
    assert.equal(debugEntry.timestamp, '12:00:00.000');
    assert.equal(debugEntry.lineNumber, 42);
    assert.equal(debugEntry.message, 'Debug message | Extra detail');
    assert.equal(debugEntry.details, undefined);

    const soqlEntry = parsed[1]!;
    assert.equal(soqlEntry.category, 'soql');
    assert.equal(soqlEntry.elapsed, '5');
    assert.equal(soqlEntry.details, 'SELECT Id FROM Account');
    assert.equal(soqlEntry.message, 'Query context');

    const dmlEntry = parsed[2]!;
    assert.equal(dmlEntry.category, 'dml');
    assert.equal(dmlEntry.message, 'Account');
    assert.equal(dmlEntry.details, 'update Account:1');

    const codeEntry = parsed[3]!;
    assert.equal(codeEntry.category, 'code');
    assert.equal(codeEntry.details, 'Handler.init');

    const limitEntry = parsed[4]!;
    assert.equal(limitEntry.category, 'limit');

    const systemEntry = parsed[5]!;
    assert.equal(systemEntry.category, 'system');

    const looseEntry = parsed[6]!;
    assert.equal(looseEntry.category, 'other');
    assert.equal(looseEntry.message, 'Loose log without separators');
  });

  test('skips blank lines and normalizes messages when details absent', () => {
    const lines = ['  ', '18:00:00.000 | USER_DEBUG | | Only message'];
    const parsed = parseLogLines(lines);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.message, 'Only message');
    assert.equal(parsed[0]!.details, undefined);
  });
});
