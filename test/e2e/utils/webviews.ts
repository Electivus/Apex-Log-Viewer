import type { Frame, Page } from '@playwright/test';
import { timeE2eStep } from './timing';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForWebviewFrame(
  page: Page,
  matcher: (frame: Frame) => Promise<boolean>,
  options?: { timeoutMs?: number }
): Promise<Frame> {
  return await timeE2eStep('webview.waitForFrame', async () => {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let sawWebviews = false;

    const tryFind = async (): Promise<Frame | undefined> => {
      const allFrames = page.frames();
      const main = page.mainFrame();
      const webviewFrames = allFrames.filter(f => /vscode-webview|vscode-webview\.net/i.test(f.url()));
      if (webviewFrames.length > 0) {
        sawWebviews = true;
      }
      // VS Code webviews often have nested iframes where the outer frame URL matches
      // vscode-webview*, but the actual content is hosted in a child frame (sometimes
      // with an about:blank URL). Prefer webview frames, but still scan all non-main
      // frames so we don't miss the content iframe.
      const nonMainFrames = allFrames.filter(f => f !== main);
      const frames = [...webviewFrames, ...nonMainFrames.filter(f => !webviewFrames.includes(f))];
      for (const frame of frames) {
        try {
          if (await matcher(frame)) {
            return frame;
          }
        } catch {
          // ignore and continue polling
        }
      }
      return undefined;
    };

    while (Date.now() < deadline) {
      const found = await tryFind();
      if (found) {
        return found;
      }
      await sleep(250);
    }

    // One last attempt right after the timeout window, to avoid flaking when the
    // webview finishes rendering between the final poll and the deadline check.
    const found = await tryFind();
    if (found) {
      return found;
    }

    // Best-effort diagnostics to make CI failures actionable.
    try {
      const main = page.mainFrame();
      const frames = page.frames().filter(f => f !== main);
      const lines: string[] = [];
      for (const frame of frames.slice(0, 25)) {
        const url = frame.url();
        const shortUrl = url.length > 180 ? `${url.slice(0, 180)}…` : url;
        const isWebview = /vscode-webview|vscode-webview\.net/i.test(url);
        const rowCount = await frame.locator('[role="row"]').count().catch(() => -1);
        const hasRefresh = await frame.locator('text=Refresh').count().catch(() => -1);
        if (isWebview || rowCount > 0 || hasRefresh > 0) {
          lines.push(`- url=${shortUrl} webview=${String(isWebview)} rows=${String(rowCount)} refreshText=${String(hasRefresh)}`);
        }
      }
      if (lines.length) {
        throw new Error(
          `${sawWebviews ? 'Timed out waiting for matching webview frame.' : 'Timed out waiting for any webview frame.'}\n` +
            `Frame diagnostics:\n${lines.join('\n')}`
        );
      }
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      }
    }
    throw new Error(sawWebviews ? 'Timed out waiting for matching webview frame.' : 'Timed out waiting for any webview frame.');
  });
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
