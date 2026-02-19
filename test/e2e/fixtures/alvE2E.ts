import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { seedApexLog } from '../utils/seedLog';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import { launchVsCode } from '../utils/vscode';

type SeededLog = {
  marker: string;
  logId: string;
};

type Fixtures = {
  scratchAlias: string;
  seededLog: SeededLog;
  workspacePath: string;
  vscodeApp: ElectronApplication;
  vscodePage: Page;
};

export const test = base.extend<Fixtures>({
  scratchAlias: async ({}, use) => {
    const scratch = await ensureScratchOrg();
    try {
      await use(scratch.scratchAlias);
    } finally {
      await scratch.cleanup();
    }
  },

  seededLog: async ({ scratchAlias }, use) => {
    const seeded = await seedApexLog(scratchAlias);
    await use(seeded);
  },

  workspacePath: async ({ scratchAlias }, use) => {
    const sfCli = await resolveSfCliInvocation();
    const ws = await createTempWorkspace({ targetOrg: scratchAlias, sfCli: sfCli ?? undefined });
    try {
      await use(ws.workspacePath);
    } finally {
      await ws.cleanup();
    }
  },

  vscodeApp: async ({ workspacePath }, use) => {
    const extensionDevelopmentPath = path.join(__dirname, '..', '..', '..');
    const launch = await launchVsCode({ workspacePath, extensionDevelopmentPath });
    try {
      await use(launch.app);
    } finally {
      await launch.cleanup();
    }
  },

  vscodePage: async ({ vscodeApp }, use) => {
    const page = await vscodeApp.firstWindow();
    await use(page);
  }
});

export { expect };
