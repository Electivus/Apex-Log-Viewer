import assert from 'assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getApexLogsDir, findExistingLogFile } from '../../../../src/utils/workspace';

suite('integration: findExistingLogFile', () => {
  test('does not create apexlogs directory when missing', async () => {
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

  test('does not return another user log when username is provided', async () => {
    const dir = getApexLogsDir();
    const logId = '07L000000000001';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `someone_else_${logId}.log`), 'body', 'utf8');

    try {
      const result = await findExistingLogFile(logId, 'target@example.com');
      assert.equal(result, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
