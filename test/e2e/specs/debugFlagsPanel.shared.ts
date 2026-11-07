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
      (await frame
        .locator('[data-testid="debug-flags-org-select"]')
        .first()
        .isVisible()
        .catch(() => false)) ||
      (await frame
        .locator('[data-testid="debug-flags-user-search"]')
        .first()
        .isVisible()
        .catch(() => false)),
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

async function countDebugFlagsFrames(page: Page): Promise<number> {
  let count = 0;
  for (const frame of page.frames()) {
    if (
      (await frame
        .locator('[data-testid="debug-flags-user-search"]')
        .count()
        .catch(() => 0)) > 0
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * The Apex Debug Flags editor is a singleton, so an open one would satisfy the frame wait after a click that never
 * reached the host. Close it first, so the only Debug Flags frame left to find is the one the next click opens.
 * A middle-click on the tab with another webview tab behind it, such as a Log Viewer, stops keys from reaching VS Code.
 */
async function closeDebugFlagsEditor(page: Page): Promise<void> {
  const tab = page.locator('.tabs-container .tab[aria-label^="Apex Debug Flags"]');
  if ((await tab.count()) > 0) {
    if (!(await page.locator('.part.editor').isVisible())) {
      // A maximized panel hides the editor area, where the Debug Flags editor opens.
      await runCommand(page, 'View: Toggle Maximized Panel');
    }
    await tab.first().click();
    await runCommand(page, 'View: Close Editor');
    await expect(tab).toHaveCount(0, { timeout: 30_000 });
  }
  await expect
    .poll(() => countDebugFlagsFrames(page), {
      message: 'no Apex Debug Flags frame is left before the click',
      timeout: 30_000
    })
    .toBe(0);
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

/**
 * Proves that the Tail toolbar button opens Apex Debug Flags: the editor that `openDebugFlagsFromLogs` left open is
 * closed first. Right after `Tail Logs` reveals the panel, a forced click on the button was lost twice in a row, so
 * this clicks with Playwright's actionability checks, then falls back to Enter and a DOM click.
 */
export async function openDebugFlagsFromTail(vscodePage: Page): Promise<Frame> {
  await closeDebugFlagsEditor(vscodePage);
  await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
  const tailFrame = await waitForWebviewFrame(
    vscodePage,
    async frame => await frame.locator('[data-testid="tail-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  const openDebugFlags = tailFrame.locator('[data-testid="tail-open-debug-flags"]').first();
  await expect(openDebugFlags).toBeEnabled({ timeout: 180_000 });
  await dismissAllNotifications(vscodePage);
  await closeQuickInputIfOpen(vscodePage);

  const attempts = [
    () => openDebugFlags.click({ timeout: 15_000 }),
    async () => {
      await openDebugFlags.focus();
      await openDebugFlags.press('Enter');
    },
    () => openDebugFlags.evaluate((button: HTMLButtonElement) => button.click())
  ];
  for (const attempt of attempts) {
    await attempt().catch(() => {});
    const frame = await tryWaitForDebugFlagsFrame(vscodePage, 10_000);
    if (frame) {
      return frame;
    }
  }
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
  const targetButton = debugFlagsFrame.locator(`[data-testid="${ui.buttonTestId}"]`);

  await expect(targetButton).toBeEnabled({ timeout: 180_000 });
  await targetButton.click();
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
