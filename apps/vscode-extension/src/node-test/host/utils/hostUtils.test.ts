import assert from 'node:assert/strict';

import { isAbortError, isAbortLikeError } from '../../../host/utils/abort';
import { trimOldest } from '../../../host/utils/trimOldest';

function named(name: string, message = ''): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

suite('abort detection', () => {
  test('an AbortError is an abort and nothing else is', () => {
    assert.equal(isAbortError(named('AbortError', 'aborted')), true);
    assert.equal(isAbortError(new Error('aborted by the user')), false);
    assert.equal(isAbortError('AbortError'), false);
    assert.equal(isAbortError(undefined), false);
    assert.equal(isAbortError(null), false);
  });

  test('a cancellation reported as text is abort-like, a real failure is not', () => {
    assert.equal(isAbortLikeError(named('AbortError')), true);
    assert.equal(isAbortLikeError(new Error('Command was canceled')), true);
    assert.equal(isAbortLikeError(new Error('request cancelled')), true);
    assert.equal(isAbortLikeError(new Error('The operation was aborted')), true);
    assert.equal(isAbortLikeError(new Error('INVALID_SESSION_ID')), false);
    assert.equal(isAbortLikeError({}, 'the call was ABORTED'), true);
    assert.equal(isAbortLikeError(new Error('timeout'), 'something else'), false);
  });
});

suite('trimOldest', () => {
  test('keeps the newest entries up to the limit and forgets the oldest', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ]);

    trimOldest(map, 2);

    assert.deepEqual([...map.keys()], ['b', 'c']);
  });

  test('leaves a map within its limit alone, and an entry set again counts as the newest', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2]
    ]);
    trimOldest(map, 2);
    assert.deepEqual([...map.keys()], ['a', 'b']);

    map.delete('a');
    map.set('a', 3);
    map.set('c', 4);
    trimOldest(map, 2);

    assert.deepEqual([...map.keys()], ['a', 'c']);
    trimOldest(map, 0);
    assert.equal(map.size, 0);
  });
});
