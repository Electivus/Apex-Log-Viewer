import type { Frame, Locator, Page } from '@playwright/test';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The body of the one VS Code webview document that contains an element with `testId`.
 *
 * Each webview is an iframe whose page holds the content in a nested `iframe#active-frame`. While VS Code loads new
 * content it keeps a hidden `#pending-frame` beside the active one and renames it to `#active-frame` only after
 * removing the old one, so anchoring on `#active-frame` never sees the same content twice. `page.frameLocator()`
 * without a selector searches every frame, so the lookup reaches that nested iframe from the workbench. Locators
 * chained from the returned body stay inside that document, so a selector that also matches in another open webview
 * does not collide, and they resolve again on every use, which survives VS Code replacing the content iframe.
 * If `testId` matches in two webviews at once, for example two Log Viewer tabs, Playwright fails the lookup.
 */
export function webviewWith(page: Page, testId: string): Locator {
  return page
    .frameLocator()
    .locator('iframe#active-frame')
    .contentFrame()
    .locator('body')
    .filter({ has: page.getByTestId(testId) });
}

/**
 * VS Code keeps the webview of a hidden panel or a background tab alive, with its outer iframe at
 * `visibility: hidden`. Playwright's `isVisible` looks only inside the frame, so ask the outer iframe too.
 */
async function isShown(frame: Frame): Promise<boolean> {
  const outer = await frame.parentFrame()?.frameElement();
  const visibility = await outer?.evaluate(element =>
    element instanceof Element ? getComputedStyle(element).visibility : undefined
  );
  await outer?.dispose();
  return visibility !== 'hidden';
}

/**
 * The first webview content frame on screen that shows `selector`.
 *
 * Use it where two webviews can hold the same content at once, such as the Logs panel and its editor-area copy: there
 * `webviewWith` fails, because Playwright rejects a frame lookup that matches in more than one frame, and a hidden
 * frame still matches (its visibility only counts in visibility checks). VS Code hides a webview by setting
 * `visibility: hidden` on its outer iframe, so this skips frames whose outer iframe is hidden. The `Frame` it returns
 * goes stale if VS Code replaces the content iframe.
 */
export async function shownWebviewFrame(page: Page, selector: string, timeoutMs = 120_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }
      const shown = await (async () =>
        (await frame.locator(selector).first().isVisible()) && (await isShown(frame)))().catch(() => false);
      if (shown) {
        return frame;
      }
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`No webview on screen showed ${selector} within ${timeoutMs} ms.`);
}

type PageBox = { x: number; y: number; width: number; height: number };

/** Waits until an element's box on the page reads the same several times in a row. */
export async function waitForStablePagePosition(
  target: { boundingBox(): Promise<PageBox | null> },
  options?: { timeoutMs?: number; intervalMs?: number; stableReads?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const intervalMs = options?.intervalMs ?? 100;
  const stableReads = options?.stableReads ?? 3;
  const deadline = Date.now() + timeoutMs;
  let lastKey: string | undefined;
  let sameReads = 0;
  while (true) {
    const box = await target.boundingBox();
    const key = box ? [box.x, box.y, box.width, box.height].map(value => Math.round(value)).join(',') : undefined;
    sameReads = key !== undefined && key === lastKey ? sameReads + 1 : key !== undefined ? 1 : 0;
    lastKey = key;
    if (sameReads >= stableReads) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The element did not keep the same position on the page for ${stableReads} reads within ${timeoutMs} ms (last box: ${lastKey ?? 'none'}).`
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Waits until a click on `target`, an element inside a webview, reaches the webview.
 *
 * VS Code webviews are out-of-process iframes, and Chromium routes a click to one of them by the hit-test data of the
 * last frame the workbench drew, not by the current DOM. Right after a layout change such as
 * `View: Toggle Maximized Panel`, that data can still describe the old layout, and a click aimed at the element's new
 * place goes to the workbench instead. So wait until the element stops moving, then for the workbench to draw twice.
 */
export async function waitForWebviewClickTarget(
  page: Pick<Page, 'evaluate'>,
  target: { boundingBox(): Promise<PageBox | null> },
  options?: { timeoutMs?: number; intervalMs?: number; stableReads?: number }
): Promise<void> {
  await waitForStablePagePosition(target, options);
  await page.evaluate(
    () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}
