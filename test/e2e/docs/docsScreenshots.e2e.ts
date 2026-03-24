import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { executeCommandId, runCommand, runCommandWhenAvailable } from '../utils/commandPalette';
import { emitDocsTailLog, prepareDocsScreenshotScenario } from '../utils/docsScenario';
import { dismissAllNotifications } from '../utils/notifications';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import { ensureDebugFlagsTestUser, getOrgAuth, getUserDebugTraceFlag, removeUserDebugTraceFlags } from '../utils/tooling';
import { ensureAuxiliaryBarClosed, launchVsCode } from '../utils/vscode';
import { waitForWebviewFrame } from '../utils/webviews';

const repoRoot = path.join(__dirname, '..', '..', '..');
const docsOutputDir = path.join(repoRoot, 'media', 'docs');

const screenshotFriendlyColumns = {
  order: ['operation', 'time', 'status', 'codeUnit', 'size', 'match', 'user'],
  visibility: {
    user: false,
    application: false,
    operation: true,
    time: true,
    duration: false,
    status: true,
    codeUnit: true,
    size: true,
    match: true
  },
  widths: {
    user: 160,
    operation: 170,
    time: 170,
    status: 150,
    codeUnit: 240,
    size: 90,
    match: 780
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

async function closePanel(page: Page): Promise<void> {
  try {
    await executeCommandId(page, 'workbench.action.closePanel');
  } catch {
    try {
      await executeCommandId(page, 'workbench.action.togglePanel');
    } catch {
      // best-effort
    }
  }
}

async function maximizePanel(page: Page): Promise<void> {
  try {
    await executeCommandId(page, 'workbench.action.toggleMaximizedPanel');
  } catch {
    // best-effort
  }
}

async function waitForLogsFrame(page: Page): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
}

async function waitForViewerFrame(page: Page): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame => await frame.locator('text=Apex Log Viewer').first().isVisible(),
    { timeoutMs: 180_000 }
  );
}

async function waitForDebugFlagsFrame(page: Page): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame => await frame.locator('[data-testid="debug-level-manager"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
}

async function waitForTailFrame(page: Page): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame => await frame.locator('[data-testid="tail-open-debug-flags"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
}

async function captureFrameBody(frame: Frame, fileName: string): Promise<void> {
  await mkdir(docsOutputDir, { recursive: true });
  const targetPath = path.join(docsOutputDir, fileName);
  const body = frame.locator('body');
  await body.waitFor({ state: 'visible', timeout: 60_000 });
  await body.screenshot({
    path: targetPath,
    animations: 'disabled'
  });
}

async function ensureTailDebugLevelReady(frame: Frame): Promise<void> {
  const debugLevelTrigger = frame.locator('[data-testid="tail-debug-level"]').first();
  await debugLevelTrigger.waitFor({ state: 'visible', timeout: 60_000 });

  const hasSelectedDebugLevel = async (): Promise<boolean> => {
    const text = (await debugLevelTrigger.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim() || '';
    return Boolean(text) && !/^select$/i.test(text);
  };

  if (await hasSelectedDebugLevel()) {
    return;
  }

  const nativeSelect = frame.locator('select[data-testid="tail-debug-level"]').first();
  if ((await nativeSelect.count()) > 0) {
    const values = await nativeSelect.locator('option').evaluateAll(options =>
      options
        .map(option => (option as HTMLOptionElement).value)
        .filter(value => Boolean(value) && value !== '__radix_empty__')
    );
    const preferredValue = values.find(value => value === 'ALV_E2E') ?? values[0];
    if (preferredValue) {
      await nativeSelect.selectOption(preferredValue);
      await expect.poll(hasSelectedDebugLevel, { timeout: 30_000 }).toBe(true);
      return;
    }
  }

  await debugLevelTrigger.click({ force: true });
  const listbox = frame.locator('[role="listbox"]').last();
  await listbox.waitFor({ state: 'visible', timeout: 30_000 });
  const preferredOption = listbox.getByRole('option', { name: 'ALV_E2E' }).first();
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click({ force: true });
  } else {
    const options = listbox.getByRole('option');
    await expect.poll(async () => await options.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await options.first().click({ force: true });
  }
  await expect.poll(hasSelectedDebugLevel, { timeout: 30_000 }).toBe(true);
}

async function prepareLogsHero(page: Page, query: string, options?: { maximizePanel?: boolean }): Promise<Frame> {
  await runCommandWhenAvailable(page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
  await dismissAllNotifications(page);
  await closeQuickInputIfOpen(page);
  if (options?.maximizePanel) {
    await maximizePanel(page);
  }

  const logsFrame = await waitForLogsFrame(page);
  const searchInput = logsFrame.locator('input[type="search"]').first();
  const rows = logsFrame.locator('[role="row"][tabindex="0"]');
  await searchInput.waitFor({ state: 'visible', timeout: 60_000 });
  await searchInput.fill(query);

  await expect.poll(async () => await rows.count(), { timeout: 180_000 }).toBeGreaterThan(1);
  await expect
    .poll(async () => await logsFrame.locator('mark.match-highlight').count(), { timeout: 180_000 })
    .toBeGreaterThan(1);
  await expect
    .poll(async () => await logsFrame.locator('[data-testid="logs-error-badge"]').count(), { timeout: 180_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await logsFrame.locator('[data-testid="logs-reason-badge"]').count(), { timeout: 180_000 })
    .toBeGreaterThan(0);

  return logsFrame;
}

test('captures README screenshots from a realistic scratch-org scenario', async () => {
  test.setTimeout(30 * 60 * 1000);

  let cleanupScratchOrg: undefined | (() => Promise<void>);
  let cleanupWorkspace: undefined | (() => Promise<void>);
  let cleanupVsCode: undefined | (() => Promise<void>);

  const screenshotPaths = {
    hero: 'hero.png',
    logViewer: 'log-viewer.png',
    debugFlags: 'debug-flags.png',
    tail: 'tail.png'
  };

  try {
    console.info('[docs] Ensuring scratch org...');
    const scratch = await ensureScratchOrg();
    cleanupScratchOrg = scratch.cleanup;

    console.info('[docs] Preparing debug flags user...');
    const auth = await getOrgAuth(scratch.scratchAlias);
    const debugUser = await ensureDebugFlagsTestUser(auth);
    await removeUserDebugTraceFlags(auth, debugUser.id).catch(() => {});

    console.info('[docs] Creating temporary workspace...');
    const sfCli = await resolveSfCliInvocation();
    const workspace = await createTempWorkspace({
      targetOrg: scratch.scratchAlias,
      sfCli: sfCli ?? undefined,
      settings: {
        'electivus.apexLogs.logsColumns': screenshotFriendlyColumns
      }
    });
    cleanupWorkspace = workspace.cleanup;

    console.info('[docs] Seeding docs screenshot scenario...');
    const scenario = await prepareDocsScreenshotScenario({
      targetOrg: scratch.scratchAlias,
      workspacePath: workspace.workspacePath
    });

    console.info('[docs] Launching VS Code...');
    const launch = await launchVsCode({
      workspacePath: workspace.workspacePath,
      extensionDevelopmentPath: repoRoot,
      windowSize: { width: 1760, height: 1360 }
    });
    cleanupVsCode = launch.cleanup;

    const vscodePage = launch.page;
    await dismissAllNotifications(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);

    console.info('[docs] Capturing hero screenshot...');
    const heroFrame = await prepareLogsHero(vscodePage, scenario.searchQuery, { maximizePanel: true });
    await heroFrame.evaluate(() => {
      document.body.style.zoom = '0.8';
      document.body.style.transformOrigin = 'top left';
    });
    await ensureAuxiliaryBarClosed(vscodePage);
    await captureFrameBody(heroFrame, screenshotPaths.hero);
    await heroFrame.evaluate(() => {
      document.body.style.zoom = '';
      document.body.style.transformOrigin = '';
    });

    console.info('[docs] Capturing dedicated log viewer screenshot...');
    const heroSearchInput = heroFrame.locator('input[type="search"]').first();
    await heroSearchInput.fill(scenario.logs.viewerRich.marker);
    await expect
      .poll(async () => await heroFrame.locator('[role="row"][tabindex="0"]').count(), { timeout: 180_000 })
      .toBe(1);
    const viewerRow = heroFrame.locator('[role="row"][tabindex="0"]').first();
    await viewerRow.click();
    await viewerRow.press('Enter');

    const viewerFrame = await waitForViewerFrame(vscodePage);
    await closePanel(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    await expect(viewerFrame.locator(`text=${scenario.logs.viewerRich.logId}`).first()).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => await viewerFrame.locator('aside ul button').count(), { timeout: 180_000 })
      .toBeGreaterThan(0);
    await viewerFrame.locator('aside').getByRole('button', { name: 'Errors' }).click({ force: true });
    await viewerFrame.locator('input[placeholder="Search entries…"]').fill(scenario.viewerSearchQuery);
    await expect(viewerFrame.locator(`text=${scenario.viewerSearchQuery}`).first()).toBeVisible({ timeout: 60_000 });
    await viewerFrame.locator('aside ul button').first().click({ force: true });
    await ensureAuxiliaryBarClosed(vscodePage);
    await captureFrameBody(viewerFrame, screenshotPaths.logViewer);

    console.info('[docs] Opening tail for debug flags entrypoint...');
    await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
    await dismissAllNotifications(vscodePage);
    await closeQuickInputIfOpen(vscodePage);
    await maximizePanel(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    const tailFrameForDebugFlags = await waitForTailFrame(vscodePage);
    await expect(tailFrameForDebugFlags.locator('[data-testid="tail-open-debug-flags"]').first()).toBeEnabled({
      timeout: 180_000
    });
    await tailFrameForDebugFlags.locator('[data-testid="tail-open-debug-flags"]').first().click({ force: true });

    console.info('[docs] Capturing debug flags screenshot...');
    const debugFlagsFrame = await waitForDebugFlagsFrame(vscodePage);
    await closePanel(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    const userSearchInput = debugFlagsFrame.locator('[data-testid="debug-flags-user-search"]');
    await userSearchInput.fill(debugUser.username);
    const userRow = debugFlagsFrame.locator(`[data-testid="debug-flags-user-row-${debugUser.id}"]`);
    await userRow.waitFor({ state: 'visible', timeout: 60_000 });
    await userRow.click();
    await debugFlagsFrame.locator('[data-testid="debug-flags-ttl"]').fill('45');
    await debugFlagsFrame.locator('[data-testid="debug-flags-apply"]').click();
    await expect
      .poll(async () => Boolean((await getUserDebugTraceFlag(auth, debugUser.id))?.id), { timeout: 60_000 })
      .toBe(true);
    await debugFlagsFrame.locator('[data-testid="debug-level-manager-new"]').click();
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-developer-name"]').fill('ALV_DOCS_CAPTURE');
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-master-label"]').fill('ALV Docs Capture');
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-language"]').fill('en_US');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-apexCode"]').selectOption('DEBUG');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-database"]').selectOption('INFO');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-system"]').selectOption('DEBUG');
    await ensureAuxiliaryBarClosed(vscodePage);
    await captureFrameBody(debugFlagsFrame, screenshotPaths.debugFlags);

    console.info('[docs] Capturing tail screenshot...');
    await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
    await dismissAllNotifications(vscodePage);
    await closeQuickInputIfOpen(vscodePage);
    await maximizePanel(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    const tailFrame = await waitForTailFrame(vscodePage);
    const tailSearchInput = tailFrame.locator('input[type="search"]').first();
    await tailSearchInput.fill(scenario.tailSearchQuery);
    await ensureTailDebugLevelReady(tailFrame);

    const startButton = tailFrame.getByRole('button', { name: 'Start' });
    if (await startButton.isVisible().catch(() => false)) {
      await startButton.click({ force: true });
      await vscodePage.waitForTimeout(1_000);
    }

    const liveTailLog = await emitDocsTailLog(scratch.scratchAlias);
    await expect(tailFrame.locator(`text=${liveTailLog.marker}`).first()).toBeVisible({ timeout: 180_000 });
    const firstTailRow = tailFrame.locator('[role="row"]').first();
    await firstTailRow.click();
    await ensureAuxiliaryBarClosed(vscodePage);
    await captureFrameBody(tailFrame, screenshotPaths.tail);

    console.info('[docs] Docs screenshots captured successfully.');
    await removeUserDebugTraceFlags(auth, debugUser.id).catch(() => {});
  } finally {
    await cleanupVsCode?.().catch(() => {});
    await cleanupWorkspace?.().catch(() => {});
    await cleanupScratchOrg?.().catch(() => {});
  }
});
