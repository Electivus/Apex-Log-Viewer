import { strict as assert } from 'assert';
import { buildLogFilename } from '../../src/lib/filename.js';

describe('buildLogFilename', () => {
  it('combines start time, username, and logId', () => {
    const name = buildLogFilename('20240102T030405Z', 'user@example.com', '07Lxx0000000001');
    assert.equal(name, '20240102T030405Z_user@example.com_07Lxx0000000001.log');
  });

  it('sanitizes unsafe characters in usernames', () => {
    const name = buildLogFilename('20240102T030405Z', 'user/evil:bad\\name', '07Lxx0000000001');
    assert.equal(name, '20240102T030405Z_user_evil_bad_name_07Lxx0000000001.log');
  });
});
