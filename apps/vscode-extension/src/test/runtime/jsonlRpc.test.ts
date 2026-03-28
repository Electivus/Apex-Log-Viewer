import assert from 'assert/strict';
import {
  JsonlDecodeError,
  splitJsonl,
} from '../../../../../packages/app-server-client-ts/src/index';

suite('jsonl rpc', () => {
  test('collects malformed frames instead of throwing during decode', () => {
    const decoded = splitJsonl('{"ok":1}\nnot-json\n{"still":"fine"}\npartial');

    assert.deepEqual(decoded.messages, [{ ok: 1 }, { still: 'fine' }]);
    assert.equal(decoded.rest, 'partial');
    assert.equal(decoded.errors.length, 1);
    assert.equal(decoded.errors[0] instanceof JsonlDecodeError, true);
    assert.match(decoded.errors[0]?.message ?? '', /invalid JSONL frame/);
  });
});
