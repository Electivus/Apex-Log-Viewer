import type { Frame } from '@playwright/test';
import { expect, test } from '../fixtures/alvE2E';
import {
  deleteDebugLevelByDeveloperName,
  ensureDebugFlagsTestUser,
  getDebugLevelByDeveloperName,
  getDebugLevelById,
  getOrgAuth,
  removeUserDebugTraceFlags
} from '../utils/tooling';
import { openDebugFlagsFromLogs } from './debugFlagsPanel.shared';

async function waitForManagerReady(debugFlagsFrame: Frame): Promise<void> {
  await expect(debugFlagsFrame.locator('[data-testid="debug-level-manager-new"]')).toBeEnabled({ timeout: 120_000 });
  await expect(debugFlagsFrame.locator('[data-testid="debug-level-manager-select"]')).toBeEnabled({ timeout: 120_000 });
}

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
    const debugFlagsFrame = await openDebugFlagsFromLogs(vscodePage);

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
    await waitForManagerReady(debugFlagsFrame);

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
    await waitForManagerReady(debugFlagsFrame);

    await debugFlagsFrame.locator('[data-testid="debug-level-delete"]').click({ force: true });
    await debugFlagsFrame.locator('[data-testid="debug-level-delete-confirmation"]').waitFor({
      state: 'visible',
      timeout: 60_000
    });
    await debugFlagsFrame.locator('[data-testid="debug-level-delete-confirm"]').click({ force: true });

    await expect
      .poll(async () => await getDebugLevelById(auth, created!.id), { timeout: 60_000 })
      .toBeUndefined();
  } finally {
    await removeUserDebugTraceFlags(auth, testUser.id).catch(() => {});
    await deleteDebugLevelByDeveloperName(auth, createdDeveloperName).catch(() => {});
    await deleteDebugLevelByDeveloperName(auth, updatedDeveloperName).catch(() => {});
  }
});
