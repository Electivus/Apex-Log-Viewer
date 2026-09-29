import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import { launchVsCode, resolveExtensionDevelopmentPath } from '../utils/vscode';
import { test as base } from './alvPoolLease';

type Fixtures = {
  workspacePath: string;
  vscodeApp: ElectronApplication;
  vscodePage: Page;
};

type Options = {
  supportExtensionIds: string[];
};

export const test = base.extend<Fixtures & Options>({
  supportExtensionIds: [[], { option: true }],

  workspacePath: async ({ scratchAlias, poolLease }, use, testInfo) => {
    const sfCli = await resolveSfCliInvocation();
    const ws = await createTempWorkspace({ targetOrg: scratchAlias, sfCli: sfCli ?? undefined });
    try {
      await use(ws.workspacePath);
    } finally {
      // Preserve temp artifacts on failures so flaky E2E runs can be inspected locally.
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
