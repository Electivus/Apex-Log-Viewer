import assert from 'assert/strict';
import { promises as fs } from 'fs';
import { getApexLogsDir, findExistingLogFile } from '../utils/workspace';

suite('integration: findExistingLogFile', () => {
  test('does not create log directory when missing', async () => {
    const dir = getApexLogsDir();
    await fs.rm(dir, { recursive: true, force: true });
    const result = await findExistingLogFile('nope');
    assert.equal(result, undefined);
    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  });
});
