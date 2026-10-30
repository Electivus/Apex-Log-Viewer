// Turn the experimental Custom Logs setting on or off in the workspace settings, as a user does, and read back
// what VS Code shows: the panel tab, the Command Palette entries and any open Custom Logs editor tab.
// args: { enabled?: boolean | null }
//   true (default): write the setting on; false: write it off; null: remove the key (the default, off)
const SETTING = 'electivus.apexLogViewer.customLogs.enabled';

export default async function ({ page, h, expect, args }) {
  const value = args.enabled === null ? undefined : args.enabled !== false;
  const shown = value === true;
  await h.dismissNotifications();
  await h.setWorkspaceSetting(SETTING, value);

  const panelTab = page.locator('.part.panel .composite-bar .action-label', { hasText: 'Electivus Custom Logs' });
  // Eight panel tabs do not fit next to the side bars; VS Code moves the extra ones into the "..." overflow menu.
  // Closing the primary side bar opens the Chat side bar, so close that one too.
  await h.runCommand('View: Close Primary Side Bar');
  await h.closeAuxiliaryBar();
  if (!(await page.locator('.part.panel').isVisible())) {
    await h.runCommand('View: Toggle Panel Visibility');
  }
  if (shown) {
    await expect(panelTab).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(panelTab).toHaveCount(0, { timeout: 30_000 });
  }
  const panelTabs = (await page.locator('.part.panel .composite-bar .action-label').allInnerTexts())
    .map(text => text.trim())
    .filter(Boolean);
  const panelShot = await h.shot('custom-logs-setting-panel-tabs');

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+Shift+P`);
  const quickInput = page.locator('div.quick-input-widget');
  await quickInput.getByRole('combobox').or(quickInput.getByRole('textbox')).first().fill('> Custom Logs');
  await page.waitForTimeout(800);
  const paletteEntries = (await quickInput.locator('.monaco-list-row').allInnerTexts())
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(text => /Electivus Apex Logs/.test(text));
  const paletteShot = await h.shot('custom-logs-setting-command-palette');
  await page.keyboard.press('Escape');

  const customLogsEntries = paletteEntries.filter(text => /Custom Logs/.test(text));
  expect(customLogsEntries.length).toBe(shown ? 3 : 0);

  const editorTabs = await page
    .locator('.part.editor .tabs-container .tab')
    .filter({ hasText: /Electivus Custom Logs|Custom log:/ })
    .count();
  if (!shown) {
    expect(editorTabs).toBe(0);
  }

  expect(panelTabs).toEqual(expect.arrayContaining(['Electivus Apex Logs', 'Electivus Apex Logs Tail']));
  return { setting: value ?? 'removed (default)', panelTabs, customLogsEntries, editorTabs, panelShot, paletteShot };
}
