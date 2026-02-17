import type { Page } from '@playwright/test';

function getModifierKey(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

async function openQuickOpen(page: Page): Promise<void> {
  const modifier = getModifierKey();
  await page.keyboard.press(`${modifier}+P`);

  const input = page.locator('div.quick-input-widget input');
  await input.waitFor({ state: 'visible', timeout: 15_000 });
}

function noMatchingResults(widget: ReturnType<Page['locator']>) {
  return widget.getByText('No matching results', { exact: true });
}

export async function runCommand(page: Page, command: string): Promise<void> {
  await openQuickOpen(page);
  const widget = page.locator('div.quick-input-widget');
  const input = widget.locator('input');
  const query = command.trim().startsWith('>') ? command.trim() : `> ${command}`;
  await input.fill(query);
  await page.waitForTimeout(50);

  const noMatches = noMatchingResults(widget);
  if (await noMatches.isVisible()) {
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
    await openQuickOpen(page);
    const widget = page.locator('div.quick-input-widget');
    const input = widget.locator('input');
    const q = query.trim().startsWith('>') ? query.trim() : `> ${query}`;
    await input.fill(q);
    await page.waitForTimeout(50);
    const noMatches = noMatchingResults(widget);
    const ok = !(await noMatches.isVisible());
    await page.keyboard.press('Escape');
    if (ok) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for command to appear in palette: "${query}"`);
}

export async function executeCommandId(page: Page, commandId: string): Promise<void> {
  await runCommand(page, 'Developer: Execute Command...');

  const widget = page.locator('div.quick-input-widget');
  const input = widget.locator('input');
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

  const widget = page.locator('div.quick-input-widget');
  const input = widget.locator('input');
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
