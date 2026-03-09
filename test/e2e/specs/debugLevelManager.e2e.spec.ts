import { expect, test } from '../fixtures/alvE2E';
import { runCommand, waitForCommandAvailable } from '../utils/commandPalette';
import {
  deleteDebugLevelByDeveloperName,
  ensureDebugFlagsTestUser,
  getDebugLevelByDeveloperName,
  getDebugLevelById,
  getOrgAuth,
  removeUserDebugTraceFlags
} from '../utils/tooling';
import { dismissAllNotifications } from '../utils/notifications';
import { waitForWebviewFrame } from '../utils/webviews';

test('creates, updates and deletes DebugLevel records from the manager UI', async ({ vscodePage, scratchAlias }) => {
  const auth = await getOrgAuth(scratchAlias);
  const testUser = await ensureDebugFlagsTestUser(auth);
  const createdDeveloperName = `ALV_E2E_DL_${Date.now()}`;
  const updatedDeveloperName = `${createdDeveloperName}_UPD`;
  const createdLabel = `${createdDeveloperName} Label`;
  const updatedLabel = `${updatedDeveloperName} Label`;

  await removeUserDebugTraceFlags(auth, testUser.id).catch(() => {});
  await deleteDebugLevelByDeveloperName(auth, createdDeveloperName).catch(() => {});
  await deleteDebugLevelByDeveloperName(auth, updatedDeveloperName).catch(() => {});

  try {
    await waitForCommandAvailable(vscodePage, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 90_000 });
    await runCommand(vscodePage, 'Electivus Apex Logs: Refresh Logs');

    const logsFrame = await waitForWebviewFrame(
      vscodePage,
      async frame => await frame.locator('[data-testid="logs-open-debug-flags"]').first().isVisible(),
      { timeoutMs: 180_000 }
    );
    const openDebugFlags = logsFrame.locator('[data-testid="logs-open-debug-flags"]').first();
    await expect(openDebugFlags).toBeEnabled({ timeout: 180_000 });
    await dismissAllNotifications(vscodePage);
    await openDebugFlags.click({ force: true });

    const debugFlagsFrame = await waitForWebviewFrame(
      vscodePage,
      async frame => await frame.locator('[data-testid="debug-level-manager"]').first().isVisible(),
      { timeoutMs: 180_000 }
    );

    await debugFlagsFrame.locator('[data-testid="debug-level-manager"]').waitFor({ state: 'visible', timeout: 60_000 });
    const newDebugLevelButton = debugFlagsFrame.locator('[data-testid="debug-level-manager-new"]');
    await expect(newDebugLevelButton).toBeEnabled({ timeout: 120_000 });
    await newDebugLevelButton.click({ force: true });

    await debugFlagsFrame.locator('[data-testid="debug-level-draft-developer-name"]').fill(createdDeveloperName);
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-master-label"]').fill(createdLabel);
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-language"]').fill('en_US');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-apexCode"]').selectOption('DEBUG');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-callout"]').selectOption('WARN');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-wave"]').selectOption('ERROR');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-dataAccess"]').selectOption('FINE');

    await debugFlagsFrame.locator('[data-testid="debug-level-save"]').click({ force: true });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => await getDebugLevelByDeveloperName(auth, createdDeveloperName), { timeout: 60_000 })
      .toMatchObject({
        developerName: createdDeveloperName,
        masterLabel: createdLabel,
        language: 'en_US',
        apexCode: 'DEBUG',
        callout: 'WARN',
        wave: 'ERROR',
        dataAccess: 'FINE'
      });

    const created = await getDebugLevelByDeveloperName(auth, createdDeveloperName);
    expect(created?.id).toBeTruthy();

    await debugFlagsFrame.locator('[data-testid="debug-level-manager-select"]').selectOption(created!.id);
    await debugFlagsFrame.locator('[data-testid="debug-level-preset-select"]').selectOption('integration-troubleshooting');
    await debugFlagsFrame.locator('[data-testid="debug-level-apply-preset"]').click({ force: true });
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-developer-name"]').fill(updatedDeveloperName);
    await debugFlagsFrame.locator('[data-testid="debug-level-draft-master-label"]').fill(updatedLabel);
    await debugFlagsFrame.locator('[data-testid="debug-level-field-wave"]').selectOption('DEBUG');
    await debugFlagsFrame.locator('[data-testid="debug-level-field-nba"]').selectOption('ERROR');
    await debugFlagsFrame.locator('[data-testid="debug-level-save"]').click({ force: true });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => await getDebugLevelById(auth, created!.id), { timeout: 60_000 })
      .toMatchObject({
        id: created!.id,
        developerName: updatedDeveloperName,
        masterLabel: updatedLabel,
        callout: 'DEBUG',
        apexCode: 'DEBUG',
        wave: 'DEBUG',
        nba: 'ERROR'
      });

    await debugFlagsFrame.locator('[data-testid="debug-level-delete"]').click({ force: true });
    await debugFlagsFrame.locator('[data-testid="debug-level-delete-confirmation"]').waitFor({
      state: 'visible',
      timeout: 60_000
    });
    await debugFlagsFrame.locator('[data-testid="debug-level-delete-confirm"]').click({ force: true });
    await expect(debugFlagsFrame.locator('[data-testid="debug-flags-notice"]')).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => await getDebugLevelById(auth, created!.id), { timeout: 60_000 })
      .toBeUndefined();
  } finally {
    await removeUserDebugTraceFlags(auth, testUser.id).catch(() => {});
    await deleteDebugLevelByDeveloperName(auth, createdDeveloperName).catch(() => {});
    await deleteDebugLevelByDeveloperName(auth, updatedDeveloperName).catch(() => {});
  }
});
