import type { ElectronApplication, TestInfo } from '@playwright/test';

export function shouldRecordTrace(mode: string, retry: number): boolean {
  switch (mode) {
    case 'on':
    case 'retain-on-failure':
    case 'retain-on-first-failure':
      return true;
    case 'on-first-retry':
      return retry === 1;
    case 'on-all-retries':
      return retry > 0;
    default:
      return false;
  }
}

export function shouldKeepTrace(mode: string, failed: boolean): boolean {
  return (
    mode === 'on' || mode === 'on-first-retry' || mode === 'on-all-retries' || (failed && mode.startsWith('retain-on'))
  );
}

// Playwright traces only the contexts it creates, so the config's `trace` never reaches the Electron app.
export async function recordElectronTrace(app: ElectronApplication, testInfo: TestInfo): Promise<() => Promise<void>> {
  const setting = testInfo.project.use.trace;
  const mode = (typeof setting === 'object' ? setting.mode : setting) ?? 'off';
  if (!shouldRecordTrace(mode, testInfo.retry)) return async () => {};
  const tracing = app.context().tracing;
  await tracing.start({ screenshots: true, snapshots: true });

  return async () => {
    if (!shouldKeepTrace(mode, testInfo.status !== testInfo.expectedStatus)) {
      await tracing.stop().catch(() => undefined);
      return;
    }
    const path = testInfo.outputPath('electron-trace.zip');
    await tracing
      .stop({ path })
      .then(() => testInfo.attach('electron-trace', { path, contentType: 'application/zip' }))
      .catch(() => console.warn('[e2e] VS Code trace unavailable.'));
  };
}
