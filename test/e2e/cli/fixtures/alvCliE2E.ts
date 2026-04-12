import { test as base, expect } from '@playwright/test';
import { ensureScratchOrg } from '../../utils/scratchOrg';
import { clearOrgApexLogs, seedApexLog } from '../../utils/seedLog';
import { createTempWorkspace } from '../../utils/tempWorkspace';
import { runAlvCli, type CliRunResult, type CliExecOptions } from '../utils/cli';

type SeededLog = {
  marker: string;
  logId: string;
};

type ScratchLeaseState = {
  scratch: Awaited<ReturnType<typeof ensureScratchOrg>>;
  hadFailure: boolean;
  failureMessage?: string;
};

type Fixtures = {
  scratchAlias: string;
  seededLog: SeededLog;
  workspacePath: string;
  runCli: (args: string[], options?: CliExecOptions) => Promise<CliRunResult>;
  scratchLeaseState: ScratchLeaseState;
};

async function attachTextArtifact(name: string, body: string, attach: (name: string, options: {
  body: Buffer;
  contentType: string;
}) => Promise<void>): Promise<void> {
  await attach(name, {
    body: Buffer.from(body, 'utf8'),
    contentType: 'text/plain'
  });
}

export const test = base.extend<Fixtures>({
  scratchLeaseState: [
    async ({}, use) => {
      const scratch = await ensureScratchOrg();
      const state: ScratchLeaseState = {
        scratch,
        hadFailure: false
      };
      try {
        await use(state);
      } finally {
        await scratch.cleanup({
          success: !state.hadFailure,
          needsRecreate: state.hadFailure,
          errorMessage: state.failureMessage,
          lastRunResult: state.hadFailure ? 'failed' : 'completed'
        });
      }
    },
    { scope: 'worker' }
  ],

  _scratchLeaseGuard: [
    async ({ scratchLeaseState }, use, testInfo) => {
      try {
        scratchLeaseState.scratch.assertLeaseHealthy?.();
      } catch (error) {
        scratchLeaseState.hadFailure = true;
        scratchLeaseState.failureMessage ??=
          error instanceof Error ? error.message : String(error);
        throw error;
      }

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        scratchLeaseState.hadFailure = true;
        scratchLeaseState.failureMessage ??=
          `Test '${testInfo.title}' ended with status '${testInfo.status}' (expected '${testInfo.expectedStatus}').`;
      }

      try {
        scratchLeaseState.scratch.assertLeaseHealthy?.();
      } catch (error) {
        scratchLeaseState.hadFailure = true;
        scratchLeaseState.failureMessage ??=
          error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    { auto: true }
  ],

  scratchAlias: [
    async ({ scratchLeaseState }, use) => {
      await use(scratchLeaseState.scratch.scratchAlias);
    },
    { scope: 'worker' }
  ],

  seededLog: async ({ scratchAlias }, use) => {
    await clearOrgApexLogs(scratchAlias, 'all');
    const seeded = await seedApexLog(scratchAlias);
    await use(seeded);
  },

  workspacePath: async ({ scratchAlias }, use, testInfo) => {
    const workspace = await createTempWorkspace({ targetOrg: scratchAlias });
    try {
      await use(workspace.workspacePath);
    } finally {
      await workspace.cleanup({ keep: testInfo.status !== testInfo.expectedStatus });
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

      return result;
    });
  }
});

export { expect };
