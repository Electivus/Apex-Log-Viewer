import { expect, type Frame, type Page } from '@playwright/test';
import { runCommand, runCommandWhenAvailable } from '../utils/commandPalette';
import { dismissAllNotifications } from '../utils/notifications';
import {
  getDebugTraceFlagByTracedEntityId,
  resolveSpecialTraceFlagTarget,
  type SpecialTraceFlagTargetType
} from '../utils/tooling';
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

async function closeQuickInputIfOpen(page: Page): Promise<void> {
  const widget = page.locator('div.quick-input-widget');
  const visible = await widget.isVisible().catch(() => false);
  if (!visible) {
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await widget.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

async function waitForLogsDebugFlagsButton(page: Page, timeoutMs: number): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs }
  );
}

async function waitForDebugFlagsFrame(page: Page, timeoutMs: number): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame =>
      (await frame.locator('[data-testid="debug-flags-org-select"]').first().isVisible().catch(() => false)) ||
      (await frame.locator('[data-testid="debug-flags-user-search"]').first().isVisible().catch(() => false)) ||
      (await frame.locator('text=Apex Debug Flags').first().isVisible().catch(() => false)),
    { timeoutMs }
  );
}

async function tryWaitForDebugFlagsFrame(page: Page, timeoutMs: number): Promise<Frame | undefined> {
  try {
    return await waitForDebugFlagsFrame(page, timeoutMs);
  } catch {
    return undefined;
  }
}

export async function openDebugFlagsFromLogs(vscodePage: Page): Promise<Frame> {
  await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await closeQuickInputIfOpen(vscodePage);

  let logsFrame: Frame;
  try {
    logsFrame = await waitForLogsDebugFlagsButton(vscodePage, 60_000);
  } catch {
    await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Open Logs in Editor Area', { timeoutMs: 90_000 });
    await closeQuickInputIfOpen(vscodePage);
    await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
    await closeQuickInputIfOpen(vscodePage);
    logsFrame = await waitForLogsDebugFlagsButton(vscodePage, 120_000);
  }
  const openDebugFlags = logsFrame.locator('[data-testid="logs-open-debug-flags"]').first();
  await expect(openDebugFlags).toBeEnabled({ timeout: 180_000 });
  await dismissAllNotifications(vscodePage);
  await closeQuickInputIfOpen(vscodePage);
  await openDebugFlags.click({ force: true });

  const initialFrame = await tryWaitForDebugFlagsFrame(vscodePage, 10_000);
  if (initialFrame) {
    return initialFrame;
  }

  await openDebugFlags.focus().catch(() => {});
  await openDebugFlags.press('Enter').catch(() => {});

  const keyboardFrame = await tryWaitForDebugFlagsFrame(vscodePage, 10_000);
  if (keyboardFrame) {
    return keyboardFrame;
  }

  await openDebugFlags.evaluate((button: HTMLButtonElement) => button.click()).catch(() => {});
  return await waitForDebugFlagsFrame(vscodePage, 180_000);
}

export async function openDebugFlagsFromTail(vscodePage: Page): Promise<Frame> {
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

  return await waitForDebugFlagsFrame(vscodePage, 180_000);
}

export async function assertSpecialTargetBehavior(
  debugFlagsFrame: Frame,
  auth: Awaited<ReturnType<typeof import('../utils/tooling').getOrgAuth>>,
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
