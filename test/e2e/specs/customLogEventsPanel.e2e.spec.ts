import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Frame, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { runCommand, runCommandWhenAvailable } from '../utils/commandPalette';
import {
  EVENTS_ORG_ALIAS,
  EVENT_OBJECTS,
  eventSourceDefinition,
  eventsOrgConfigured,
  publishEvents,
  readAllowance
} from '../utils/eventsOrg';
import { createTempWorkspace, type TempWorkspace } from '../utils/tempWorkspace';
import { launchVsCode, resolveExtensionDevelopmentPath } from '../utils/vscode';
import { waitForWebviewFrame } from '../utils/webviews';

/**
 * The Custom Logs panel on a platform event source, against the real `alv-events` scratch org (docs/TESTING.md).
 * First use asks before it spends the daily allocation and says what it would spend; "Only new events" then shows
 * rows in publish order and a strip that reaches Live. Skips on a machine without the org, so the pool-only CI is
 * untouched. Spends the events it publishes, 5.
 */

const SETTING = 'electivus.apexLogViewer.customLogs.enabled';
const EVENTS = 5;

test.skip(
  !eventsOrgConfigured(),
  'The alv-events scratch org is not authenticated here: node scripts/events-org.mjs ensure.'
);
test.describe.configure({ mode: 'serial' });

let workspace: TempWorkspace;
let app: ElectronApplication;
let page: Page;
let cleanupApp: ((options?: { keep?: boolean }) => Promise<void>) | undefined;

test.beforeAll(async () => {
  workspace = await createTempWorkspace({ targetOrg: EVENTS_ORG_ALIAS, settings: { [SETTING]: true } });
  await writeFile(
    path.join(workspace.workspacePath, 'sfdx-project.json'),
    JSON.stringify(
      {
        packageDirectories: [{ path: 'force-app', default: true }],
        namespace: '',
        sourceApiVersion: '65.0',
        plugins: { electivus: { customLogs: { sources: [eventSourceDefinition({ object: EVENT_OBJECTS.log })] } } }
      },
      null,
      2
    )
  );
  const launch = await launchVsCode({
    workspacePath: workspace.workspacePath,
    extensionDevelopmentPath: resolveExtensionDevelopmentPath(path.join(__dirname, '..', '..', '..'))
  });
  app = launch.app;
  page = await app.firstWindow();
  cleanupApp = launch.cleanup;
});

test.afterAll(async ({}, testInfo) => {
  const keep = testInfo.status !== testInfo.expectedStatus;
  await cleanupApp?.({ keep });
  await workspace?.cleanup({ keep });
});

async function openPanel(): Promise<Frame> {
  await runCommandWhenAvailable(page, 'Electivus Custom Logs: Focus on Electivus Custom Logs View', {
    timeoutMs: 90_000
  });
  await runCommandWhenAvailable(page, 'Electivus Apex Logs: Refresh Custom Logs', { timeoutMs: 90_000 });
  const frame = await waitForWebviewFrame(
    page,
    async candidate => await candidate.locator('[data-testid="custom-logs-root"]').first().isVisible(),
    { timeoutMs: 180_000 }
  );
  // The bottom panel is about 260 px tall, which hides rows from a screenshot.
  await runCommand(page, 'View: Toggle Maximized Panel');
  return frame;
}

test('first use asks before it subscribes and says what the replay would spend', async ({}, testInfo) => {
  const allowance = await readAllowance();
  const frame = await openPanel();
  const strip = frame.getByTestId('custom-logs-capture');

  await expect(strip).toHaveAttribute('data-state', 'stopped', { timeout: 120_000 });
  await expect(strip).toContainText('No events from this org are stored yet.');
  await expect(frame.getByRole('button', { name: 'Load retained events' })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Only new events' })).toBeVisible();
  const note = (await strip.innerText()).match(
    /about ([\d,]+) of ([\d,]+) left\); this run stops after about ([\d,]+) deliveries/
  );
  expect(note, await strip.innerText()).not.toBeNull();
  const [remaining, max, budget] = note!.slice(1).map(value => Number(value.replaceAll(',', '')));
  expect(max).toBe(allowance.max);
  expect(Math.abs(remaining! - allowance.remaining), 'the counter the panel shows is /limits').toBeLessThanOrEqual(50);
  expect(budget, 'about half of what remains').toBe(Math.floor(remaining! / 2));
  await testInfo.attach('first-use.png', { body: await page.screenshot(), contentType: 'image/png' });

  const eventsDirs = await readdir(path.join(workspace.workspacePath, 'apexlogs', 'orgs')).catch(() => []);
  for (const org of eventsDirs) {
    const files = await readdir(
      path.join(workspace.workspacePath, 'apexlogs', 'orgs', org, 'events', EVENT_OBJECTS.log)
    ).catch(() => []);
    expect(files, 'nothing subscribed, so no checkpoint or data exists').not.toContain('checkpoint.json');
  }
});

test('"Only new events" shows five published events in order and the strip reaches Live with its tooltip', async ({}, testInfo) => {
  const frame = await waitForWebviewFrame(
    page,
    async candidate => await candidate.locator('[data-testid="custom-logs-root"]').first().isVisible(),
    { timeoutMs: 60_000 }
  );
  const strip = frame.getByTestId('custom-logs-capture');
  await frame.getByRole('button', { name: 'Only new events' }).click();
  await expect(strip).toHaveAttribute('data-state', /catchingUp|live/, { timeout: 60_000 });

  const published = await publishEvents({ count: EVENTS, transactionId: 'panel', object: EVENT_OBJECTS.log });
  const rows = frame.locator('[data-row-id]').filter({ hasText: `(${published.runTag})` });
  await expect(rows).toHaveCount(EVENTS, { timeout: 90_000 });
  const entries = (await rows.allInnerTexts()).map(text => Number(text.match(/entry (\d+) of \d+/)?.[1]));
  expect(entries, 'newest first, so the last event published is on top').toEqual(
    Array.from({ length: EVENTS }, (_, index) => EVENTS - index)
  );

  await expect(strip).toHaveAttribute('data-state', 'live', { timeout: 90_000 });
  await expect(strip.getByText('Live', { exact: true })).toHaveAttribute('title', /Inferred: no event for 10 s/);
  await testInfo.attach('live.png', { body: await page.screenshot(), contentType: 'image/png' });
});
