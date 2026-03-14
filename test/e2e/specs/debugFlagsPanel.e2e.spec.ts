import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { runCommand, runCommandWhenAvailable } from '../utils/commandPalette';
import { dismissAllNotifications } from '../utils/notifications';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import {
  ensureDebugFlagsTestUser,
  getDebugTraceFlagByTracedEntityId,
  getOrgAuth,
  getUserDebugTraceFlag,
  removeDebugTraceFlagsByTracedEntityId,
  removeUserDebugTraceFlags,
  resolveSpecialTraceFlagTarget,
  type SpecialTraceFlagTargetType
} from '../utils/tooling';
import { launchVsCode } from '../utils/vscode';
import { waitForWebviewFrame } from '../utils/webviews';

const SPECIAL_TARGET_UI: Record<SpecialTraceFlagTargetType, { buttonTestId: string; expectedLabel: string }> = {
  automatedProcess: {
    buttonTestId: 'debug-flags-special-target-automated-process',
    expectedLabel: 'Automated Process'
  },
  platformIntegration: {
    buttonTestId: 'debug-flags-special-target-platform-integration',
    expectedLabel: 'Platform Integration'
  }
};

test.describe.configure({ mode: 'serial' });

let scratchAlias = '';
let vscodePage: Page;
let cleanupScratchOrg: undefined | (() => Promise<void>);
let cleanupWorkspace: undefined | (() => Promise<void>);
let cleanupVsCode: undefined | (() => Promise<void>);

test.beforeAll(async () => {
  const scratch = await ensureScratchOrg();
  cleanupScratchOrg = scratch.cleanup;
  scratchAlias = scratch.scratchAlias;

  const sfCli = await resolveSfCliInvocation();
  const workspace = await createTempWorkspace({ targetOrg: scratchAlias, sfCli: sfCli ?? undefined });
  cleanupWorkspace = workspace.cleanup;

  const launch = await launchVsCode({
    workspacePath: workspace.workspacePath,
    extensionDevelopmentPath: path.join(__dirname, '..', '..', '..')
  });
  cleanupVsCode = launch.cleanup;
  vscodePage = launch.page;
});

test.afterAll(async () => {
  await cleanupVsCode?.().catch(() => {});
  await cleanupWorkspace?.().catch(() => {});
  await cleanupScratchOrg?.().catch(() => {});
});

async function openDebugFlagsFromLogs(vscodePage: Parameters<typeof waitForWebviewFrame>[0]): Promise<Frame> {
  await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await closeQuickInputIfOpen(vscodePage);

  const logsFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  const openDebugFlags = logsFrame.locator('[data-testid="logs-open-debug-flags"]').first();
  await expect(openDebugFlags).toBeEnabled({ timeout: 180_000 });
  await dismissAllNotifications(vscodePage);
  await closeQuickInputIfOpen(vscodePage);
  await openDebugFlags.click({ force: true });

  return await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('text=Apex Debug Flags').first().isVisible(),
    { timeoutMs: 180_000 }
  );
}

async function closeQuickInputIfOpen(page: Page): Promise<void> {
  const widget = page.locator('div.quick-input-widget');
  const visible = await widget.isVisible().catch(() => false);
  if (!visible) {
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await widget.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

async function assertSpecialTargetBehavior(
  debugFlagsFrame: Frame,
  auth: Awaited<ReturnType<typeof getOrgAuth>>,
  targetType: SpecialTraceFlagTargetType
): Promise<void> {
  const ui = SPECIAL_TARGET_UI[targetType];
  const resolvedTarget = await resolveSpecialTraceFlagTarget(auth, targetType);
  const applyButton = debugFlagsFrame.locator('[data-testid="debug-flags-apply"]');
  const removeButton = debugFlagsFrame.locator('[data-testid="debug-flags-remove"]');
  const notice = debugFlagsFrame.locator('[data-testid="debug-flags-notice"]');
  const unavailableNotice = debugFlagsFrame.locator('[data-testid="debug-flags-target-unavailable"]');
  const selectedTargetLabel = debugFlagsFrame.locator('[data-testid="debug-flags-selected-target-label"]');

  await debugFlagsFrame.locator(`[data-testid="${ui.buttonTestId}"]`).click();
  await expect(selectedTargetLabel).toContainText(ui.expectedLabel, { timeout: 60_000 });

  if (!resolvedTarget) {
    await expect(unavailableNotice).toContainText(ui.expectedLabel, { timeout: 60_000 });
    await expect(applyButton).toBeDisabled();
    await expect(removeButton).toBeDisabled();
    return;
  }

  await expect(applyButton).toBeEnabled({ timeout: 60_000 });
  await expect(removeButton).toBeEnabled({ timeout: 60_000 });

  const ttlInput = debugFlagsFrame.locator('[data-testid="debug-flags-ttl"]');
  await ttlInput.fill('20');

  await applyButton.click();
  await expect(notice).toBeVisible({ timeout: 60_000 });

  await expect
    .poll(
      async () => {
        const statuses = await Promise.all(
          resolvedTarget.ids.map(async tracedEntityId => await getDebugTraceFlagByTracedEntityId(auth, tracedEntityId))
        );
        return statuses.every(status => Boolean(status?.id));
      },
      { timeout: 60_000 }
    )
    .toBe(true);

  await removeButton.click();
  await expect(notice).toBeVisible({ timeout: 60_000 });

  await expect
    .poll(
      async () => {
        const statuses = await Promise.all(
          resolvedTarget.ids.map(async tracedEntityId => await getDebugTraceFlagByTracedEntityId(auth, tracedEntityId))
        );
        return statuses.every(status => !status?.id);
      },
      { timeout: 60_000 }
    )
    .toBe(true);
}

test('configures and removes debug flags from logs and tail entrypoints', async () => {
  const auth = await getOrgAuth(scratchAlias);
  const testUser = await ensureDebugFlagsTestUser(auth);
  const userId = testUser.id;
  await removeUserDebugTraceFlags(auth, userId);

  try {
    const debugFlagsFrame = await openDebugFlagsFromLogs(vscodePage);

    const searchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
    await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
    await searchInput.fill(testUser.username);

    const userRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${userId}"]`);
    await userRow.waitFor({ state: 'visible', timeout: 60_000 });
    await userRow.click();

    const ttlInput = debugFlagsFrame.locator('[data-testid="debug-flags-ttl"]');
    await ttlInput.fill('45');

    await debugFlagsFrame.locator('[data-testid="debug-flags-apply"]').click();
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const status = await getUserDebugTraceFlag(auth, userId);
          return status?.id || '';
        },
        { timeout: 60_000 }
      )
      .not.toBe('');

    await debugFlagsFrame.locator('[data-testid="debug-flags-remove"]').click();
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const status = await getUserDebugTraceFlag(auth, userId);
          return status?.id || '';
        },
        { timeout: 60_000 }
      )
      .toBe('');

    await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
    const tailFrame = await waitForWebviewFrame(
      vscodePage,
      async frame => await frame.locator('[data-testid="tail-open-debug-flags"]').first().isVisible(),
      { timeoutMs: 180_000 }
    );
    await expect(tailFrame.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({ timeout: 180_000 });
    await dismissAllNotifications(vscodePage);
    await closeQuickInputIfOpen(vscodePage);
    await tailFrame.locator('[data-testid="tail-open-debug-flags"]').first().click({ force: true });

    const debugFlagsFrameFromTail = await waitForWebviewFrame(
      vscodePage,
      async frame => await frame.locator('text=Apex Debug Flags').first().isVisible(),
      { timeoutMs: 180_000 }
    );
    await expect(debugFlagsFrameFromTail.locator('text=Apex Debug Flags').first()).toBeVisible();
  } finally {
    await removeUserDebugTraceFlags(auth, userId).catch(() => {});
  }
});

test('supports special trace flag targets in the debug flags panel', async () => {
  const auth = await getOrgAuth(scratchAlias);
  const automatedProcessTarget = await resolveSpecialTraceFlagTarget(auth, 'automatedProcess');
  const platformIntegrationTarget = await resolveSpecialTraceFlagTarget(auth, 'platformIntegration');

  if (automatedProcessTarget?.ids?.length) {
    for (const tracedEntityId of automatedProcessTarget.ids) {
      await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
    }
  }
  if (platformIntegrationTarget?.ids?.length) {
    for (const tracedEntityId of platformIntegrationTarget.ids) {
      await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
    }
  }

  try {
    const debugFlagsFrame = await openDebugFlagsFromLogs(vscodePage);

    await assertSpecialTargetBehavior(debugFlagsFrame, auth, 'automatedProcess');
    await assertSpecialTargetBehavior(debugFlagsFrame, auth, 'platformIntegration');
  } finally {
    if (automatedProcessTarget?.ids?.length) {
      for (const tracedEntityId of automatedProcessTarget.ids) {
        await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
      }
    }
    if (platformIntegrationTarget?.ids?.length) {
      for (const tracedEntityId of platformIntegrationTarget.ids) {
        await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
      }
    }
  }
});
