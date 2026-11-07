import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { runCommand, runCommandWhenAvailable } from '../utils/commandPalette';
import {
  DOCS_CUSTOM_LOG_SOURCE,
  DOCS_CUSTOM_LOGS_FILTER,
  DOCS_TAIL_ALERT_LINE,
  clearDocsCustomLogs,
  emitDocsTailLog,
  prepareDocsScreenshotScenario,
  seedDocsCustomLogs
} from '../utils/docsScenario';
import { dismissAllNotifications } from '../utils/notifications';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { createTempWorkspace } from '../utils/tempWorkspace';
import {
  ensureDebugFlagsTestUser,
  getOrgAuth,
  getUserDebugTraceFlag,
  removeUserDebugTraceFlags,
  setE2eDebugLevelDatabase
} from '../utils/tooling';
import { ensureAuxiliaryBarClosed, launchVsCode, resolveExtensionDevelopmentPath } from '../utils/vscode';
import { waitForWebviewFrame } from '../utils/webviews';

const repoRoot = path.join(__dirname, '..', '..', '..');
const docsOutputDir = path.join(repoRoot, 'apps', 'vscode-extension', 'media', 'docs');

type DocsShot = { fileName: string; viewport: { width: number; height: number } };

const docsShots = {
  hero: { fileName: 'hero.png', viewport: { width: 1440, height: 420 } },
  logViewer: { fileName: 'log-viewer.png', viewport: { width: 1100, height: 760 } },
  debugFlags: { fileName: 'debug-flags.png', viewport: { width: 1100, height: 1090 } },
  tail: { fileName: 'tail.png', viewport: { width: 1440, height: 560 } },
  customLogs: { fileName: 'custom-logs.png', viewport: { width: 1440, height: 456 } }
} satisfies Record<string, DocsShot>;

const screenshotFriendlyColumns = {
  order: ['operation', 'time', 'status', 'size', 'match', 'codeUnit', 'user'],
  visibility: {
    user: false,
    application: false,
    operation: true,
    time: true,
    duration: false,
    status: true,
    codeUnit: false,
    size: true,
    match: true
  },
  widths: {
    user: 160,
    operation: 230,
    time: 150,
    status: 235,
    codeUnit: 240,
    size: 70,
    match: 590
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
    // The palette lists `View: Hide Panel` only while the panel is open.
    await runCommand(page, 'View: Hide Panel');
  } catch {
    // best-effort
  }
}

async function closePrimarySideBar(page: Page): Promise<void> {
  if (await page.locator('.part.sidebar').isVisible()) {
    await runCommand(page, 'View: Close Primary Side Bar');
    await expect(page.locator('.part.sidebar')).toBeHidden({ timeout: 10_000 });
  }
}

async function maximizePanel(page: Page): Promise<void> {
  try {
    // A maximized panel hides the editor area, and the command toggles.
    if (await page.locator('.part.editor').isVisible()) {
      await runCommand(page, 'View: Toggle Maximized Panel');
    }
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
    async frame => await frame.locator('[data-testid="log-viewer"]').first().isVisible(),
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

async function waitForCustomLogsFrame(page: Page): Promise<Frame> {
  return await waitForWebviewFrame(
    page,
    async frame => await frame.locator('[data-testid="custom-logs-root"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
}

async function captureShot(page: Page, frame: Frame, shot: DocsShot, options?: { keepFocus?: boolean }): Promise<void> {
  await mkdir(docsOutputDir, { recursive: true });
  await page.setViewportSize(shot.viewport);
  await ensureAuxiliaryBarClosed(page);
  await page.mouse.move(0, 0);
  if (!options?.keepFocus) {
    await frame.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  const body = frame.locator('body');
  await body.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await body.screenshot({
    path: path.join(docsOutputDir, shot.fileName),
    animations: 'disabled'
  });
}

async function mapDocsCustomLogSource(workspacePath: string): Promise<void> {
  const projectPath = path.join(workspacePath, 'sfdx-project.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.plugins = { electivus: { customLogs: { sources: [DOCS_CUSTOM_LOG_SOURCE] } } };
  await writeFile(projectPath, JSON.stringify(project, null, 2), 'utf8');
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
    const values = await nativeSelect
      .locator('option')
      .evaluateAll(options =>
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
  let cleanupOrgData: undefined | (() => Promise<void>);

  try {
    console.info('[docs] Ensuring scratch org...');
    const scratch = await ensureScratchOrg();
    cleanupScratchOrg = scratch.cleanup;

    console.info('[docs] Preparing debug flags user...');
    const auth = await getOrgAuth(scratch.scratchAlias);
    const debugUser = await ensureDebugFlagsTestUser(auth);
    await removeUserDebugTraceFlags(auth, debugUser.id).catch(() => {});
    cleanupOrgData = async () => {
      await removeUserDebugTraceFlags(auth, debugUser.id).catch(() => {});
      await clearDocsCustomLogs(auth).catch(() => {});
      await setE2eDebugLevelDatabase(auth, 'ERROR').catch(() => {});
    };
    // The Log Viewer's SOQL and DML filters count only what the debug level writes to the log.
    await setE2eDebugLevelDatabase(auth, 'INFO');

    console.info('[docs] Creating temporary workspace...');
    const workspace = await createTempWorkspace({
      targetOrg: scratch.scratchAlias,
      settings: {
        'electivus.apexLogViewer.logs.columns': screenshotFriendlyColumns,
        'electivus.apexLogViewer.customLogs.enabled': true
      }
    });
    cleanupWorkspace = workspace.cleanup;
    await mapDocsCustomLogSource(workspace.workspacePath);

    console.info('[docs] Seeding docs screenshot scenario...');
    const scenario = await prepareDocsScreenshotScenario({
      targetOrg: scratch.scratchAlias,
      workspacePath: workspace.workspacePath
    });

    console.info('[docs] Launching VS Code...');
    const launch = await launchVsCode({
      workspacePath: workspace.workspacePath,
      extensionDevelopmentPath: resolveExtensionDevelopmentPath(repoRoot),
      windowSize: { width: 1440, height: 900 }
    });
    cleanupVsCode = launch.cleanup;

    const vscodePage = launch.page;
    await dismissAllNotifications(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    await closePrimarySideBar(vscodePage);

    console.info('[docs] Capturing hero screenshot...');
    const heroFrame = await prepareLogsHero(vscodePage, scenario.searchQuery, { maximizePanel: true });
    await captureShot(vscodePage, heroFrame, docsShots.hero, { keepFocus: true });

    console.info('[docs] Capturing dedicated log viewer screenshot...');
    const heroSearchInput = heroFrame.locator('input[type="search"]').first();
    await heroSearchInput.fill(scenario.logs.viewerRich.marker);
    await expect
      .poll(async () => await heroFrame.locator('[role="row"][tabindex="0"]').count(), { timeout: 180_000 })
      .toBe(1);
    const viewerRow = heroFrame.locator(`[data-log-id="${scenario.logs.viewerRich.logId}"]`);
    await viewerRow.getByRole('button', { name: 'Open' }).click({ force: true });

    const viewerFrame = await waitForViewerFrame(vscodePage);
    await closePanel(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    await expect(viewerFrame.locator(`text=${scenario.logs.viewerRich.logId}`).first()).toBeVisible({
      timeout: 60_000
    });
    await expect
      .poll(async () => await viewerFrame.locator('aside ul button').count(), { timeout: 180_000 })
      .toBeGreaterThan(0);
    await expect(viewerFrame.locator('[data-testid="log-viewer-failure"]')).toBeVisible({ timeout: 60_000 });
    await vscodePage.setViewportSize(docsShots.logViewer.viewport);
    const failedEntry = viewerFrame.getByText('EXCEPTION_THROWN').first();
    await viewerFrame.locator('[data-testid="log-viewer-go-to-error"]').click();
    await expect(failedEntry).toBeInViewport({ timeout: 5_000 });
    await captureShot(vscodePage, viewerFrame, docsShots.logViewer);
    await expect(failedEntry).toBeInViewport({ timeout: 1_000 });

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
    await captureShot(vscodePage, debugFlagsFrame, docsShots.debugFlags);

    console.info('[docs] Capturing tail screenshot...');
    await runCommand(vscodePage, 'Electivus Apex Logs: Tail Logs');
    await dismissAllNotifications(vscodePage);
    await closeQuickInputIfOpen(vscodePage);
    await maximizePanel(vscodePage);
    await ensureAuxiliaryBarClosed(vscodePage);
    const tailFrame = await waitForTailFrame(vscodePage);
    await ensureTailDebugLevelReady(tailFrame);

    const startButton = tailFrame.getByRole('button', { name: 'Start' });
    if (await startButton.isVisible().catch(() => false)) {
      await startButton.click({ force: true });
      await vscodePage.waitForTimeout(1_000);
    }

    await tailFrame.getByRole('switch', { name: 'Color' }).click();
    await vscodePage.setViewportSize(docsShots.tail.viewport);
    await emitDocsTailLog(scratch.scratchAlias);
    await expect(
      tailFrame.locator('[role="row"]', { hasText: 'USER_DEBUG' }).filter({ hasText: DOCS_TAIL_ALERT_LINE })
    ).toBeInViewport({ timeout: 180_000 });
    await captureShot(vscodePage, tailFrame, docsShots.tail);
    await tailFrame.getByRole('button', { name: 'Stop' }).click();
    await expect(tailFrame.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 60_000 });

    console.info('[docs] Capturing custom logs screenshot...');
    await seedDocsCustomLogs(auth);
    await runCommandWhenAvailable(vscodePage, 'Custom Logs: Focus on Custom Logs View', { timeoutMs: 90_000 });
    await runCommandWhenAvailable(vscodePage, 'Electivus Apex Logs: Refresh Custom Logs', { timeoutMs: 90_000 });
    await dismissAllNotifications(vscodePage);
    await closeQuickInputIfOpen(vscodePage);
    await maximizePanel(vscodePage);
    const customLogsFrame = await waitForCustomLogsFrame(vscodePage);
    await expect
      .poll(async () => await customLogsFrame.locator('[data-row-id]').count(), { timeout: 180_000 })
      .toBeGreaterThan(1);
    const customLogsFilter = customLogsFrame.getByRole('combobox', { name: 'Filter logs' });
    await customLogsFilter.fill(DOCS_CUSTOM_LOGS_FILTER);
    await customLogsFilter.press('Enter');
    await customLogsFilter.press('Escape');
    await expect(customLogsFrame.locator('[data-testid="filter-chip"]', { hasText: 'http.status' })).toBeVisible({
      timeout: 60_000
    });
    await captureShot(vscodePage, customLogsFrame, docsShots.customLogs);

    console.info('[docs] Docs screenshots captured successfully.');
  } finally {
    await cleanupOrgData?.();
    await cleanupVsCode?.().catch(() => {});
    await cleanupWorkspace?.().catch(() => {});
    await cleanupScratchOrg?.().catch(() => {});
  }
});
