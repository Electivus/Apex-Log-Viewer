import type { Page } from '@playwright/test';
import { timeE2eStep } from './timing';

function getModifierKey(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

function getQuickInput(page: Page) {
  const widget = page.locator('div.quick-input-widget');
  const input = widget.getByRole('combobox');
  return { widget, input };
}

async function openCommandPalette(page: Page): Promise<void> {
  const modifier = getModifierKey();
  await page.keyboard.press(`${modifier}+Shift+P`);

  const { input } = getQuickInput(page);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
}

function noMatchingResults(widget: ReturnType<Page['locator']>) {
  return widget.getByText('No matching results', { exact: true });
}

function normalizeCommandQuery(command: string): string {
  return command.trim().startsWith('>') ? command.trim() : `> ${command}`;
}

async function openCommandPaletteWithCommand(page: Page, command: string): Promise<boolean> {
  await openCommandPalette(page);
  const { widget, input } = getQuickInput(page);
  await input.fill(normalizeCommandQuery(command));
  await page.waitForTimeout(50);
  return !(await noMatchingResults(widget).isVisible());
}

export async function runCommand(page: Page, command: string): Promise<void> {
  if (!(await openCommandPaletteWithCommand(page, command))) {
    await page.keyboard.press('Escape');
    throw new Error(`Command not found in palette: "${command}"`);
  }

  await page.keyboard.press('Enter');
}

export async function waitForCommandAvailable(
  page: Page,
  query: string,
  options?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await openCommandPaletteWithCommand(page, query);
    await page.keyboard.press('Escape');
    if (ok) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for command to appear in palette: "${query}"`);
}

export async function runCommandWhenAvailable(
  page: Page,
  command: string,
  options?: { timeoutMs?: number }
): Promise<void> {
  await timeE2eStep(`commandPalette.runWhenAvailable:${command}`, async () => {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ok = await openCommandPaletteWithCommand(page, command);
      if (ok) {
        await page.keyboard.press('Enter');
        return;
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    throw new Error(`Timed out waiting for command to appear in palette: "${command}"`);
  });
}

export async function executeCommandId(page: Page, commandId: string): Promise<void> {
  await runCommand(page, 'Developer: Execute Command...');

  const { widget, input } = getQuickInput(page);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(commandId);
  await page.waitForTimeout(50);

  const noMatches = noMatchingResults(widget);
  if (await noMatches.isVisible()) {
    await page.keyboard.press('Escape');
    throw new Error(`Command id not found: "${commandId}"`);
  }

  await page.keyboard.press('Enter');
}

export async function openView(page: Page, viewName: string): Promise<void> {
  await runCommand(page, 'View: Open View...');

  const { widget, input } = getQuickInput(page);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(viewName);
  await page.waitForTimeout(50);

  const noMatches = noMatchingResults(widget);
  if (await noMatches.isVisible()) {
    await page.keyboard.press('Escape');
    throw new Error(`View not found in picker: "${viewName}"`);
  }

  await page.keyboard.press('Enter');
}
