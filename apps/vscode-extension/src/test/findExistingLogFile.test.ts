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

  test('findExistingLogFile resolves a nested org-first path for the matching username', async () => {
    const dir = getApexLogsDir();
    const logId = '07L000000000001AA';
    const nested = path.join(dir, 'orgs', 'target@example.com', 'logs', '2026-03-30', `${logId}.log`);
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'body', 'utf8');

    try {
      const result = await findExistingLogFile(logId, 'target@example.com');
      assert.equal(result, nested);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('findExistingLogFile does not resolve a nested path from the wrong org tree when username is provided', async () => {
    const dir = getApexLogsDir();
    const logId = '07L000000000003AA';
    const wrongNested = path.join(dir, 'orgs', 'someone-else@example.com', 'logs', '2026-03-30', `${logId}.log`);
    await fs.mkdir(path.dirname(wrongNested), { recursive: true });
    await fs.writeFile(wrongNested, 'body', 'utf8');

    try {
      const result = await findExistingLogFile(logId, 'target@example.com');
      assert.equal(result, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('findExistingLogFile can fall back to any org-first match when no username is provided', async () => {
    const dir = getApexLogsDir();
    const logId = '07L000000000002AA';
    const nested = path.join(dir, 'orgs', 'default@example.com', 'logs', '2026-03-30', `${logId}.log`);
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'body', 'utf8');

    try {
      const result = await findExistingLogFile(logId);
      assert.equal(result, nested);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
