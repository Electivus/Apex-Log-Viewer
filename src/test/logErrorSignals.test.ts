import assert from 'assert/strict';
import { extractLogEventType, isErrorEventType, lineHasErrorSignal, tokenizeLogEventType } from '../shared/logErrorSignals';

suite('logErrorSignals', () => {
  test('tokenizes event types using uppercase alpha groups', () => {
    assert.deepEqual(tokenizeLogEventType('EXCEPTION_THROWN'), ['EXCEPTION', 'THROWN']);
    assert.deepEqual(tokenizeLogEventType('fatal.error'), ['FATAL', 'ERROR']);
  });

  test('detects error event types', () => {
    assert.equal(isErrorEventType('EXCEPTION_THROWN'), true);
    assert.equal(isErrorEventType('FATAL_ERROR'), true);
    assert.equal(isErrorEventType('METHOD_ENTRY'), false);
    assert.equal(isErrorEventType('USER_DEBUG'), false);
  });

  test('extracts event type from pipe-delimited lines', () => {
    assert.equal(extractLogEventType('12:00:00.000 | EXCEPTION_THROWN | [6] | message'), 'EXCEPTION_THROWN');
    assert.equal(extractLogEventType('line without delimiter'), undefined);
  });

  test('detects error markers from log lines', () => {
    assert.equal(lineHasErrorSignal('12:00:00.000 | EXCEPTION_THROWN | [6] | message'), true);
    assert.equal(lineHasErrorSignal('12:00:00.000 | USER_DEBUG | [6] | message with error text'), false);
  });
});
