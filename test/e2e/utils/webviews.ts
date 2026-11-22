import { expect, type Locator, type Page } from '@playwright/test';

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
 * The body of the content document of the webview whose outer iframe is named `name`. VS Code names each webview's
 * outer iframe by the webview's id, so the locator keeps following that webview, and anchoring on `#active-frame`
 * makes it resolve again on every use: a content swap moves it to the new document, never to the hidden pending one.
 */
function webviewBody(page: Page, name: string): Locator {
  return page
    .locator(`iframe.webview[name=${JSON.stringify(name)}]`)
    .contentFrame()
    .locator('iframe#active-frame')
    .contentFrame()
    .locator('body');
}

/** The time source of `shownWebview`: `now()` in ms, and a sleep of `ms`. */
export type LookupClock = { now(): number; sleep(ms: number): Promise<void> };

/** The default clock of `shownWebview`: `Date.now` and this module's `sleep`. Exported for its test. */
export const systemClock: LookupClock = { now: () => Date.now(), sleep };

/**
 * The body of the first webview on screen whose content shows `selector`.
 *
 * Use it where two webviews can hold the same content at once, such as the Logs panel and its editor-area copy: there
 * `webviewWith` fails, because Playwright rejects a frame lookup that matches in more than one frame, even a hidden
 * one. VS Code keeps the webview of a hidden panel or a background tab alive with its outer iframe at
 * `visibility: hidden`, so this picks among the outer iframes that are not, and returns a locator bound to that
 * webview's identity. Unlike a `Frame`, the locator survives VS Code replacing the content iframe. It polls every
 * 250 ms. `timeoutMs` is the cutoff for starting a new poll, not for the call: the first poll always runs, and a poll
 * still running at the cutoff finishes and can return its webview after `timeoutMs`. After a poll that finds nothing,
 * the helper sleeps for 250 ms or for the time left before the cutoff, whichever is shorter (no time when the cutoff
 * has passed): it reads the clock to compute the delay, awaits the sleep (even when the delay is zero), then reads the
 * clock again to decide whether to poll or reject for timeout. Before the cutoff it polls again, at or after it it
 * rejects. So it never rejects before the cutoff, and how long after depends on when the sleep's timer fires. `clock`
 * replaces `Date.now` and the sleep, for tests.
 */
export async function shownWebview(
  page: Page,
  selector: string,
  timeoutMs = 120_000,
  clock: LookupClock = systemClock
): Promise<Locator> {
  const deadline = clock.now() + timeoutMs;
  do {
    const shownNames = await page
      .locator('iframe.webview')
      .evaluateAll(frames =>
        frames.filter(frame => getComputedStyle(frame).visibility !== 'hidden').map(frame => frame.getAttribute('name'))
      )
      .catch(() => []);
    for (const name of shownNames) {
      if (!name) {
        continue;
      }
      const body = webviewBody(page, name);
      if (
        await body
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        return body;
      }
    }
    await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
  } while (clock.now() < deadline);
  throw new Error(`No webview on screen showed ${selector} within ${timeoutMs} ms.`);
}

/**
 * Asserts that `webview` is present and holds no element matching `inner`, both in the same lookup. A bare
 * `toHaveCount(0)` on a locator inside a webview also passes when the webview content is gone. `inner` is a selector
 * or a locator built from the page, such as `page.getByRole('status')`.
 */
export async function expectWebviewWithout(
  webview: Locator,
  inner: string | Locator,
  options?: { timeout?: number }
): Promise<void> {
  const hasNot = typeof inner === 'string' ? webview.page().locator(inner) : inner;
  await expect(webview.filter({ hasNot })).toHaveCount(1, options);
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
