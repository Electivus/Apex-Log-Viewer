import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { seedApexLog } from '../utils/seedLog';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import { launchVsCode, resolveExtensionDevelopmentPath } from '../utils/vscode';

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
  vscodeApp: ElectronApplication;
  vscodePage: Page;
  scratchLeaseState: ScratchLeaseState;
};

type Options = {
  supportExtensionIds: string[];
};

export const test = base.extend<Fixtures & Options>({
  supportExtensionIds: [[], { option: true }],

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
    const seeded = await seedApexLog(scratchAlias);
    await use(seeded);
  },

  workspacePath: async ({ scratchAlias }, use, testInfo) => {
    const sfCli = await resolveSfCliInvocation();
    const ws = await createTempWorkspace({ targetOrg: scratchAlias, sfCli: sfCli ?? undefined });
    try {
      await use(ws.workspacePath);
    } finally {
      await ws.cleanup({ keep: testInfo.status !== testInfo.expectedStatus });
    }
  },

  vscodeApp: async ({ workspacePath, supportExtensionIds }, use, testInfo) => {
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const extensionDevelopmentPath = resolveExtensionDevelopmentPath(repoRoot);
    const launch = await launchVsCode({
      workspacePath,
      extensionDevelopmentPath,
      extensionIds: supportExtensionIds
    });
    try {
      await use(launch.app);
    } finally {
      await launch.cleanup({ keep: testInfo.status !== testInfo.expectedStatus });
    }
  },

  vscodePage: async ({ vscodeApp }, use) => {
    const page = await vscodeApp.firstWindow();
    await use(page);
  }
});

export { expect };
