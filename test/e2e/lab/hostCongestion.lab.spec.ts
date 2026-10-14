import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Frame } from '@playwright/test';
import { test } from '../fixtures/alvPoolLease';
import { runCommandWhenAvailable } from '../utils/commandPalette';
import { closeQuickInputIfOpen, dismissAllNotifications } from '../utils/notifications';
import { seedApexLog } from '../utils/seedLog';
import { resolveSfCliInvocation } from '../utils/sfCli';
import { createTempWorkspace } from '../utils/tempWorkspace';
import { getOrgAuth } from '../utils/tooling';
import { launchVsCode, resolveExtensionDevelopmentPath } from '../utils/vscode';
import { waitForWebviewFrame } from '../utils/webviews';
import { summarizeQueueWaits, summarizeRefreshCycles } from '../utils/queueWaits';

const repoRoot = path.join(__dirname, '..', '..', '..');
const neighbor = process.env.ALV_LAB_NEIGHBOR?.trim() || '';
const label = process.env.ALV_LAB_LABEL?.trim() || (neighbor ? `neighbor-${neighbor.replace(/:/g, '-')}` : 'quiet');
const refreshes = Number(process.env.ALV_LAB_REFRESHES || 6);
const seedLogs = Number(process.env.ALV_LAB_SEED_LOGS || 1);
const emptyDayDirs = Number(process.env.ALV_LAB_EMPTY_DAY_DIRS || 0);
const locale = process.env.ALV_LAB_LOCALE?.trim();

function safeUsername(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.@-]+/g, '_') || 'default';
}

async function createEmptyDayDirs(workspacePath: string, username: string, count: number): Promise<void> {
  const logsRoot = path.join(workspacePath, 'apexlogs', 'orgs', safeUsername(username), 'logs');
  const day = new Date(Date.now() - 2 * 86_400_000);
  for (let i = 0; i < count; i++) {
    await mkdir(path.join(logsRoot, day.toISOString().slice(0, 10)), { recursive: true });
    day.setUTCDate(day.getUTCDate() - 1);
  }
}

async function findLogs(userDataDir: string, matches: (entry: string) => boolean): Promise<string[]> {
  const entries = await readdir(path.join(userDataDir, 'logs'), { recursive: true });
  return entries.filter(entry => entry.endsWith('.log') && matches(entry)).map(entry => path.join(userDataDir, 'logs', entry));
}

async function readAll(files: string[]): Promise<string> {
  return (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, stepMs = 20): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate().catch(() => false)) return Date.now() - started;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return Number.NaN;
}

test('host congestion lab: click-to-start wait in the extension host queue', async ({ scratchAlias }, testInfo) => {
  test.setTimeout(30 * 60_000);
  for (let i = 0; i < seedLogs; i++) await seedApexLog(scratchAlias);
  const auth = await getOrgAuth(scratchAlias);
  const sfCli = await resolveSfCliInvocation();
  const ws = await createTempWorkspace({
    targetOrg: scratchAlias,
    sfCli: sfCli ?? undefined,
    settings: { 'electivus.apexLogViewer.logging.trace': true }
  });
  if (emptyDayDirs > 0 && auth.username) await createEmptyDayDirs(ws.workspacePath, auth.username, emptyDayDirs);

  const launch = await launchVsCode({
    workspacePath: ws.workspacePath,
    extensionDevelopmentPath: resolveExtensionDevelopmentPath(repoRoot),
    additionalExtensionDevelopmentPaths: [path.join(__dirname, 'noisy-neighbor')],
    env: { ALV_LAB_NEIGHBOR: neighbor, ...(locale ? { LC_ALL: locale, LANG: locale } : {}) }
  });
  try {
    const page = launch.page;
    await runCommandWhenAvailable(page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 180_000 });
    await closeQuickInputIfOpen(page);
    const frame: Frame = await waitForWebviewFrame(
      page,
      async candidate => await candidate.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
      { timeoutMs: 300_000 }
    );
    const refresh = frame.getByRole('button', { name: /^(Refresh|Loading)/ }).first();
    await waitUntil(async () => await refresh.isEnabled(), 300_000, 200);
    await page.waitForTimeout(15_000);

    for (let i = 0; i < refreshes; i++) {
      await dismissAllNotifications(page).catch(() => undefined);
      await waitUntil(async () => await refresh.isEnabled(), 180_000, 50);
      await refresh.click();
      await page.waitForTimeout(8_000);
    }

    const search = frame.locator('input[type="search"]').first();
    await search.pressSequentially('exception', { delay: 80 });
    await page.waitForTimeout(10_000);
    await search.fill('');
    await page.waitForTimeout(3_000);
  } finally {
    const outputLogs = await findLogs(launch.userDataDir, entry => entry.includes('Electivus Apex Log Viewer')).catch(
      () => []
    );
    const outputLog = await readAll(outputLogs);
    const neighborLog = await readAll(
      await findLogs(launch.userDataDir, entry => entry.includes('ALV lab noisy neighbor')).catch(() => [])
    );
    const neighborRunning = /noisy neighbor running busy=\d+ period=\d+ pool=\d+/.exec(neighborLog)?.[0] ?? 'not running';
    const report = {
      label,
      neighbor: neighbor || 'none',
      locale: locale || 'default',
      seedLogs,
      emptyDayDirs,
      refreshes,
      gitSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim(),
      platform: `${process.platform}-${process.arch}`,
      generatedAt: new Date().toISOString(),
      outputLogFiles: outputLogs.length,
      neighborRunning,
      refreshCycles: summarizeRefreshCycles(outputLog),
      queueWaits: summarizeQueueWaits(outputLog)
    };
    const reportDir = path.join(repoRoot, 'output', 'lab', 'host-congestion');
    await mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${label}-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await writeFile(reportPath.replace(/\.json$/, '.output.log'), outputLog);
    console.log(`[lab] report: ${reportPath}`);
    console.log(`[lab] ${neighborRunning}`);
    console.table(report.queueWaits.byType);
    console.table([report.refreshCycles]);
    await launch.cleanup({ keep: testInfo.status !== testInfo.expectedStatus });
    await ws.cleanup();
  }
});
