import type { Locator, Page } from '@playwright/test';
import { timeE2eStep } from './timing';

const COMMAND_PALETTE_SHORTCUT_TIMEOUT_MS = 3_000;
const OPEN_QUICK_ACCESS_BUTTON_TIMEOUT_MS = 2_000;
const QUICK_INPUT_TIMEOUT_MS = 15_000;
const QUICK_INPUT_READ_TIMEOUT_MS = 500;
const COMMAND_ROW_TIMEOUT_MS = 2_000;
const COMMAND_ROW_POLL_MS = 50;

function getPaletteShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';
}

function getQuickInput(page: Page): { widget: Locator; input: Locator } {
  const widget = page.locator('div.quick-input-widget');
  const input = widget.getByRole('combobox').or(widget.getByRole('textbox')).first();
  return { widget, input };
}

async function waitForQuickInput(page: Page, timeout: number): Promise<void> {
  const { input } = getQuickInput(page);
  await input.waitFor({ state: 'visible', timeout });
}

async function openCommandPalette(page: Page): Promise<void> {
  const shortcut = getPaletteShortcut();
  await page.keyboard.press(shortcut);

  try {
    await waitForQuickInput(page, COMMAND_PALETTE_SHORTCUT_TIMEOUT_MS);
    return;
  } catch {
    try {
      await page
        .getByRole('button', { name: /Open Quick Access/i })
        .click({ timeout: OPEN_QUICK_ACCESS_BUTTON_TIMEOUT_MS });
      // The button's tooltip opens moments later over the editor tabs, where it fails Playwright's next hit test before
      // that click moves the mouse. Only a move inside the workbench cancels the tooltip; a move into a webview does not.
      await page.mouse.move(0, 0);
    } catch {
      // Older or renamed VS Code layouts may not expose this Chat-focus fallback.
    }
  }

  try {
    await waitForQuickInput(page, QUICK_INPUT_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`Neither ${shortcut} nor the Open Quick Access button opened the palette`, { cause: error });
  }
}

function noMatchingResults(widget: ReturnType<Page['locator']>) {
  return widget.getByText('No matching results', { exact: true });
}

function normalizeCommandQuery(command: string): string {
  return command.trim().startsWith('>') ? command.trim() : `> ${command}`;
}

function commandLabel(command: string): string {
  return command.trim().replace(/^>\s*/, '');
}

interface CommandRow {
  index: number;
  label: string;
  /** The English title VS Code shows under a translated one when a language pack is active; empty otherwise. */
  alias: string;
  focused: boolean;
}

async function readCommandRows(widget: Locator): Promise<CommandRow[]> {
  return await widget.locator('.monaco-list-row').evaluateAll(rows =>
    rows.map(row => {
      // A recycled row can keep the alias text of an earlier command in a hidden label, so read only a shown one.
      const meta = row.querySelector<HTMLElement>('.quick-input-list-label-meta .monaco-icon-label');
      const alias =
        meta && meta.style.display !== 'none'
          ? (meta.querySelector('.monaco-icon-name-container')?.textContent ?? '').trim()
          : '';
      return {
        index: Number(row.getAttribute('data-index') ?? '-1'),
        label: (row.querySelector('.quick-input-list-row .monaco-icon-name-container')?.textContent ?? '').trim(),
        alias,
        focused: row.classList.contains('focused')
      };
    })
  );
}

type ExactRowResult = { found: true } | { found: false; labels: string[] };

/**
 * Moves the quick pick focus to the first row labelled exactly `label`, or else to the first row whose English title
 * is `label` in a translated VS Code. VS Code's palette matches words anywhere in a label, also lists similar
 * commands, and puts recently used ones first, so its first row can be another command: `View: Close Editor` lists
 * `View: Close All Editor Groups` first, and `Electivus Apex Logs: Refresh Logs` can list `Electivus Apex Logs:
 * Refresh Custom Logs` first. The rows must read the same twice in a row, so a list that is still filtering is not
 * trusted.
 */
async function focusExactRow(page: Page, label: string): Promise<ExactRowResult> {
  const { widget } = getQuickInput(page);
  const deadline = Date.now() + COMMAND_ROW_TIMEOUT_MS;
  let previous = '';
  let labels: string[] = [];

  for (;;) {
    const rows = await readCommandRows(widget);
    labels = rows.map(row => row.label);
    const snapshot = JSON.stringify(rows);
    const settled = snapshot === previous;
    previous = snapshot;

    if (settled) {
      const target = rows.find(row => row.label === label) ?? rows.find(row => row.alias === label);
      const focused = rows.find(row => row.focused);
      if (target && focused) {
        if (target.index === focused.index) {
          return { found: true };
        }
        const key = target.index > focused.index ? 'ArrowDown' : 'ArrowUp';
        for (let step = 0; step < Math.abs(target.index - focused.index); step++) {
          await page.keyboard.press(key);
        }
        previous = '';
      }
    }

    if (Date.now() >= deadline) {
      return { found: false, labels };
    }
    await page.waitForTimeout(COMMAND_ROW_POLL_MS);
  }
}

function describeRows(labels: string[]): string {
  return labels.length
    ? labels
        .slice(0, 5)
        .map(label => `"${label}"`)
        .join(', ')
    : 'none';
}

interface PaletteQuery {
  hasMatches: boolean;
  failurePrefix: string;
}

async function openCommandPaletteWithCommand(page: Page, command: string): Promise<PaletteQuery> {
  await openCommandPalette(page);
  const { widget, input } = getQuickInput(page);
  const query = normalizeCommandQuery(command);
  await input.fill(query);
  await page.waitForTimeout(50);
  // Playwright's `fill` succeeds even when the window drops the text, so only the input value shows the loss.
  // `getByRole` skips a hidden input, so a palette that closed since the fill cannot be read.
  const value = await input.inputValue({ timeout: QUICK_INPUT_READ_TIMEOUT_MS }).catch(() => undefined);
  return {
    hasMatches: !(await noMatchingResults(widget).isVisible()),
    failurePrefix:
      value === undefined || value === query
        ? ''
        : `Keys are not reaching VS Code: ${getPaletteShortcut()} and the typed query were lost, so the palette input holds "${value}" instead of "${query}". `
  };
}

/** Runs the palette command whose label is exactly `command`, and fails if the palette has none. */
export async function runCommand(page: Page, command: string): Promise<void> {
  const { hasMatches, failurePrefix } = await openCommandPaletteWithCommand(page, command);
  if (!hasMatches) {
    await page.keyboard.press('Escape');
    throw new Error(`${failurePrefix}Command not found in palette: "${command}"`);
  }

  const row = await focusExactRow(page, commandLabel(command));
  if (!row.found) {
    await page.keyboard.press('Escape');
    throw new Error(
      `${failurePrefix}No palette row is labelled exactly "${commandLabel(command)}"; the palette listed ${describeRows(row.labels)}`
    );
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

  let labels: string[] = [];
  let failurePrefix = '';
  while (Date.now() < deadline) {
    const opened = await openCommandPaletteWithCommand(page, query);
    const row = opened.hasMatches ? await focusExactRow(page, commandLabel(query)) : undefined;
    await page.keyboard.press('Escape');
    if (row?.found) {
      return;
    }
    labels = row?.labels ?? [];
    failurePrefix = opened.failurePrefix;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `${failurePrefix}Timed out waiting for command to appear in palette: "${query}"; the palette last listed ${describeRows(labels)}`
  );
}

export async function runCommandWhenAvailable(
  page: Page,
  command: string,
  options?: { timeoutMs?: number }
): Promise<void> {
  await timeE2eStep(`commandPalette.runWhenAvailable:${command}`, async () => {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;

    let labels: string[] = [];
    let failurePrefix = '';
    while (Date.now() < deadline) {
      const opened = await openCommandPaletteWithCommand(page, command);
      const row = opened.hasMatches ? await focusExactRow(page, commandLabel(command)) : undefined;
      if (row?.found) {
        await page.keyboard.press('Enter');
        return;
      }
      labels = row?.labels ?? [];
      failurePrefix = opened.failurePrefix;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    throw new Error(
      `${failurePrefix}Timed out waiting for command to appear in palette: "${command}"; the palette last listed ${describeRows(labels)}`
    );
  });
}

export async function openView(page: Page, viewName: string): Promise<void> {
  await runCommand(page, 'View: Open View');

  const { input } = getQuickInput(page);
  await input.waitFor({ state: 'visible', timeout: QUICK_INPUT_TIMEOUT_MS });
  // The picker filters after its `view ` prefix; without the prefix the input becomes a file search.
  await input.fill(`view ${viewName}`);
  await page.waitForTimeout(50);

  const row = await focusExactRow(page, viewName);
  if (!row.found) {
    await page.keyboard.press('Escape');
    throw new Error(`View not found in picker: "${viewName}"; the picker listed ${describeRows(row.labels)}`);
  }

  await page.keyboard.press('Enter');
}
