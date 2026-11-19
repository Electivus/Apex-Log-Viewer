import { rm } from 'node:fs/promises';
import type { ElectronApplication, TestInfo } from '@playwright/test';

// Mirrors Playwright's TestTracing._shouldCaptureTrace and _shouldAbandonTrace (1.65), which only run for contexts it creates.
function normalizeMode(mode: string): string {
  return mode === 'retry-with-trace' ? 'on-first-retry' : mode;
}

export function shouldRecordTrace(rawMode: string, retry: number): boolean {
  switch (normalizeMode(rawMode)) {
    case 'on':
    case 'retain-on-failure':
    case 'retain-on-failure-and-retries':
      return true;
    case 'on-first-retry':
      return retry === 1;
    case 'on-all-retries':
      return retry > 0;
    case 'retain-on-first-failure':
      return retry === 0;
    default:
      return false;
  }
}

export function shouldKeepTrace(rawMode: string, failed: boolean, retry: number): boolean {
  if (failed) return shouldRecordTrace(rawMode, retry);
  switch (normalizeMode(rawMode)) {
    case 'on':
    case 'on-first-retry':
    case 'on-all-retries':
      return shouldRecordTrace(rawMode, retry);
    case 'retain-on-failure-and-retries':
      return retry > 0;
    default:
      return false;
  }
}

export type FinishTrace = (final?: { testInfo: TestInfo; failed: boolean }) => Promise<void>;

// The config's `trace` never reaches the Electron app, so record it here. A caller that records in beforeAll
// passes the final hook's TestInfo and whether any test failed.
export async function recordElectronTrace(app: ElectronApplication, testInfo: TestInfo): Promise<FinishTrace> {
  const setting = testInfo.project.use.trace;
  const mode = (typeof setting === 'object' ? setting.mode : setting) ?? 'off';
  if (!shouldRecordTrace(mode, testInfo.retry)) return async () => {};
  const tracing = app.context().tracing;
  await tracing.start({ screenshots: true, snapshots: true });

  return async (final = { testInfo, failed: testInfo.status !== testInfo.expectedStatus }) => {
    if (!shouldKeepTrace(mode, final.failed, final.testInfo.retry)) {
      await tracing.stop().catch(() => undefined);
      return;
    }
    const path = final.testInfo.outputPath('electron-trace.zip');
    await tracing
      .stop({ path })
      .then(() => final.testInfo.attach('electron-trace', { path, contentType: 'application/zip' }))
      .then(() => rm(path, { force: true }))
      .catch(() => console.warn('[e2e] VS Code trace unavailable.'));
  };
}
