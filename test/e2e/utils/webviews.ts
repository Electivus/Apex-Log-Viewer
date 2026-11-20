import type { Locator, Page } from '@playwright/test';

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
