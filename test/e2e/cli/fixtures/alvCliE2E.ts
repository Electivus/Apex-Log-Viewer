import { expect } from '@playwright/test';
import { test as base } from '../../fixtures/alvPoolLease';
import { clearOrgApexLogs, seedApexLog } from '../../utils/seedLog';
import { createTempWorkspace } from '../../utils/tempWorkspace';
import { runAlvCli, type CliRunResult, type CliExecOptions } from '../utils/cli';

type SeededLog = {
  marker: string;
  logId: string;
};

type SyncLogsResult = {
  result: CliRunResult;
  json: any;
};

type Fixtures = {
  seededLog: SeededLog;
  workspacePath: string;
  runCli: (args: string[], options?: CliExecOptions) => Promise<CliRunResult>;
  syncLogs: () => Promise<SyncLogsResult>;
};

async function attachTextArtifact(
  name: string,
  body: string,
  attach: (
    name: string,
    options: {
      body: Buffer;
      contentType: string;
    }
  ) => Promise<void>
): Promise<void> {
  await attach(name, {
    body: Buffer.from(body, 'utf8'),
    contentType: 'text/plain'
  });
}

export function sfJsonResult(result: CliRunResult): any {
  return result.stdoutJson?.result ?? result.stdoutJson;
}

export const test = base.extend<Fixtures>({
  seededLog: async ({ scratchAlias }, use) => {
    await clearOrgApexLogs(scratchAlias, 'all');
    const seeded = await seedApexLog(scratchAlias);
    await use(seeded);
  },

  workspacePath: async ({ scratchAlias, poolLease }, use, testInfo) => {
    const workspace = await createTempWorkspace({ targetOrg: scratchAlias });
    try {
      await use(workspace.workspacePath);
    } finally {
      await poolLease.runTeardown(testInfo, () =>
        workspace.cleanup({ keep: testInfo.status !== testInfo.expectedStatus })
      );
    }
  },

  runCli: async ({ workspacePath }, use, testInfo) => {
    let invocationCount = 0;

    await use(async (args: string[], options: CliExecOptions = {}) => {
      invocationCount += 1;
      const result = await runAlvCli(args, {
        ...options,
        cwd: workspacePath
      });
      const prefix = `cli-${String(invocationCount).padStart(2, '0')}`;

      await attachTextArtifact(
        `${prefix}.command.txt`,
        [result.command, ...result.args].join(' '),
        testInfo.attach.bind(testInfo)
      );
      await attachTextArtifact(`${prefix}.stdout.txt`, result.stdout, testInfo.attach.bind(testInfo));
      await attachTextArtifact(`${prefix}.stderr.txt`, result.stderr, testInfo.attach.bind(testInfo));
      if (result.errorMessage) {
        await attachTextArtifact(`${prefix}.error.txt`, result.errorMessage, testInfo.attach.bind(testInfo));
      }

      return result;
    });
  },

  syncLogs: async ({ runCli, scratchAlias }, use) => {
    await use(async () => {
      const result = await runCli(['log', 'sync', '--json', '--target-org', scratchAlias]);
      const json = sfJsonResult(result);

      expect(result.exitCode).toBe(0);
      expect(json).toBeTruthy();
      expect(json?.status).toBe('success');
      expect(Number(json?.downloaded ?? 0)).toBeGreaterThanOrEqual(1);
      expect(json?.lastSyncedLogId).toBeTruthy();

      return {
        result,
        json
      };
    });
  }
});

export { expect };
