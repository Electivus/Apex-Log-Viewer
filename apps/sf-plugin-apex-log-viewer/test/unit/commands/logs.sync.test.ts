import { strict as assert } from 'assert';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { TestContext } from '@salesforce/core/testSetup';
import { Org, SfProject } from '@salesforce/core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import LogsSync from '../../../src/commands/apex-log-viewer/logs/sync.js';

describe('apex-log-viewer logs sync', () => {
  const $$ = new TestContext();
  let outputDir = '';

  beforeEach(async () => {
    const fakeConn = {
      tooling: {
        query: async () => ({
          records: [
            {
              Id: '07L1',
              StartTime: '2024-01-02T03:04:05.000+0000',
              LogLength: 12,
              LogUser: { Username: 'user@example.com' },
            },
          ],
        }),
      },
      request: async () => 'LOG_BODY',
      getApiVersion: () => '60.0',
      instanceUrl: 'https://example.my.salesforce.com',
    };

    const fakeOrg = {
      getConnection: () => fakeConn,
      getUsername: () => 'user@example.com',
    } as unknown as Org;

    const fakeProject = {
      resolveProjectConfig: async () => ({ sourceApiVersion: '60.0' }),
    } as unknown as SfProject;

    $$.SANDBOX.stub(Org, 'create').resolves(fakeOrg);
    $$.SANDBOX.stub(SfProject, 'resolve').resolves(fakeProject);
    stubSfCommandUx($$.SANDBOX);
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-log-viewer-'));
  });

  afterEach(async () => {
    if (outputDir) {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
    $$.restore();
  });

  it('returns json schema', async () => {
    const result = await LogsSync.run(['--json', '--target-org', 'user@example.com', '--output-dir', outputDir]);
    assert.ok(result);
    assert.equal((result as any).status, 0);
    assert.equal((result as any).result.logsSaved.length, 1);
  });
});
