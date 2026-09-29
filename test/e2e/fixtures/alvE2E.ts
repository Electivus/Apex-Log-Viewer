import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { seedApexLog } from '../utils/seedLog';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import { launchVsCode, resolveExtensionDevelopmentPath } from '../utils/vscode';
import { test as base } from './alvPoolLease';

type SeededLog = {
  marker: string;
  logId: string;
};

type Fixtures = {
  seededLog: SeededLog;
  workspacePath: string;
  vscodeApp: ElectronApplication;
  vscodePage: Page;
};

type Options = {
  supportExtensionIds: string[];
};

export const test = base.extend<Fixtures & Options>({
  supportExtensionIds: [[], { option: true }],

  seededLog: async ({ scratchAlias }, use) => {
    const seeded = await seedApexLog(scratchAlias);
    await use(seeded);
  },

  workspacePath: async ({ scratchAlias, poolLease }, use, testInfo) => {
    const sfCli = await resolveSfCliInvocation();
    const ws = await createTempWorkspace({ targetOrg: scratchAlias, sfCli: sfCli ?? undefined });
    try {
      await use(ws.workspacePath);
    } finally {
      await poolLease.runTeardown(testInfo, () => ws.cleanup({ keep: testInfo.status !== testInfo.expectedStatus }));
    }
  },

  vscodeApp: async ({ workspacePath, supportExtensionIds, poolLease }, use, testInfo) => {
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
      if (process.env.ALV_E2E_TIMING === '1' && testInfo.status !== testInfo.expectedStatus) {
        console.log(`[e2e] VS Code test status before cleanup: ${testInfo.status}`);
        if (process.platform === 'darwin') {
          await promisify(execFile)('/usr/sbin/screencapture', ['-x', testInfo.outputPath('native-failure.png')], {
            timeout: 5_000
          }).catch(() => console.warn('[e2e] Native macOS failure screenshot unavailable.'));
        }
        await launch.page
          .screenshot({ path: testInfo.outputPath('vscode-failure.png'), timeout: 5_000 })
          .catch(() => console.warn('[e2e] VS Code failure screenshot unavailable.'));
      }
      await poolLease.runTeardown(testInfo, () =>
        launch.cleanup({ keep: testInfo.status !== testInfo.expectedStatus })
      );
    }
  },

  vscodePage: async ({ vscodeApp }, use) => {
    const page = await vscodeApp.firstWindow();
    await use(page);
  }
});

export { expect };
