// Turn the experimental Custom Logs setting on or off in the workspace settings, as a user does, and read back
// what VS Code shows: the view's Focus command, the panel tab it reveals, the Command Palette entries and any
// open Custom Logs editor tab.
// args: { enabled?: boolean | null }
//   true (default): write the setting on; false: write it off; null: remove the key (the default, off)
const SETTING = 'electivus.apexLogViewer.customLogs.enabled';
const VIEW = 'Electivus Custom Logs';
const FOCUS_COMMAND = `${VIEW}: Focus on ${VIEW} View`;
const OTHER_FOCUS_COMMANDS = [
  'Electivus Apex Logs: Focus on Electivus Apex Logs View',
  'Electivus Apex Logs Tail: Focus on Electivus Apex Logs Tail View'
];

async function openPalette(page, query) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+Shift+P`);
  const quickInput = page.locator('div.quick-input-widget');
  await quickInput.getByRole('combobox').or(quickInput.getByRole('textbox')).first().fill(`> ${query}`);
  await page.waitForTimeout(800);
  const rows = (await quickInput.locator('.monaco-list-row').allInnerTexts()).map(text =>
    text.replace(/\s+/g, ' ').trim()
  );
  return { quickInput, rows };
}

async function focusCommands(page) {
  const { rows } = await openPalette(page, 'Focus on Electivus');
  await page.keyboard.press('Escape');
  return rows.filter(row => row.includes(': Focus on Electivus'));
}

export default async function ({ page, h, expect, args }) {
  const value = args.enabled === null ? undefined : args.enabled !== false;
  const shown = value === true;
  await h.dismissNotifications();
  await h.closeQuickInput();
  await h.setWorkspaceSetting(SETTING, value);

  // VS Code applies the file change a moment later; the view's Focus command exists only while the view does.
  await expect
    .poll(async () => (await focusCommands(page)).some(row => row.startsWith(FOCUS_COMMAND)), { timeout: 30_000 })
    .toBe(shown);
  const focusEntries = await focusCommands(page);
  expect(focusEntries.some(row => row.startsWith(FOCUS_COMMAND))).toBe(shown);
  for (const other of OTHER_FOCUS_COMMANDS) {
    expect(focusEntries.some(row => row.startsWith(other))).toBe(true);
  }

  // The panel fits seven tabs next to a side bar or a wide panel toolbar such as Output's. VS Code moves the rest
  // into a "..." menu, which is a native menu on macOS that Playwright cannot click. The Focus command reveals the
  // view wherever its tab sits, and VS Code keeps the active tab in the visible strip.
  const panelTab = page
    .locator('.part.panel .composite-bar .action-label')
    .filter({ hasText: new RegExp(`^${VIEW}$`) });
  let activeTab;
  if (shown) {
    const { quickInput } = await openPalette(page, FOCUS_COMMAND);
    await quickInput.locator('.monaco-list-row').filter({ hasText: FOCUS_COMMAND }).first().click();
    await expect(panelTab).toBeVisible({ timeout: 30_000 });
    activeTab = (
      await page.locator('.part.panel .composite-bar .action-item.checked .action-label').innerText()
    ).trim();
    expect(activeTab).toBe(VIEW);
    await h.customLogsFrame(60_000);
  } else {
    await expect(panelTab).toHaveCount(0, { timeout: 30_000 });
  }
  const panelTabs = (await page.locator('.part.panel .composite-bar .action-label').allInnerTexts())
    .map(text => text.trim())
    .filter(Boolean);
  const panelShot = await h.shot('custom-logs-setting-panel-tabs');

  const { rows } = await openPalette(page, 'Custom Logs');
  const paletteShot = await h.shot('custom-logs-setting-command-palette');
  await page.keyboard.press('Escape');
  const customLogsEntries = rows.filter(text => /Electivus Apex Logs/.test(text) && /Custom Logs/.test(text));
  expect(customLogsEntries.length).toBe(shown ? 3 : 0);

  const editorTabs = await page
    .locator('.part.editor .tabs-container .tab')
    .filter({ hasText: /Electivus Custom Logs|Custom log:/ })
    .count();
  if (!shown) {
    expect(editorTabs).toBe(0);
  }

  return {
    setting: value ?? 'removed (default)',
    focusEntries,
    activeTab,
    panelTabs,
    customLogsEntries,
    editorTabs,
    panelShot,
    paletteShot
  };
}
