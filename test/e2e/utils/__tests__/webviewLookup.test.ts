import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { waitForDebugFlagsFrame, waitForLogsDebugFlagsButton } from '../../specs/debugFlagsPanel.shared';
import { expectWebviewWithout, shownWebview, webviewWith } from '../webviews';

/**
 * A synthetic workbench shaped like VS Code's: each webview is an `iframe.webview` named by its id, whose page holds the
 * content in `iframe#active-frame`. New content loads into a hidden `#pending-frame`, which replaces the active one when
 * promoted. The page and the webviews are served from two origins, so Chromium puts them out of process like VS Code.
 */

const TOOLBAR = '[data-testid="logs-open-debug-flags"]';

type Content = { root: boolean; button: boolean; badge: boolean; orgSelect?: boolean; userSearch?: boolean };

function contentHtml(copy: string, version: string, content: Content): string {
  const parts = [
    content.root ? '<div data-testid="logs-errors-only-switch">Errors only</div>' : '',
    content.button
      ? `<button data-testid="logs-open-debug-flags" onclick="top.postMessage('${copy}-v${version}', '*')">Debug flags</button>`
      : '',
    content.badge ? '<span data-testid="logs-error-badge">Error</span>' : '',
    content.orgSelect ? '<div data-testid="debug-flags-org-select">default-org</div>' : '',
    content.userSearch ? '<input data-testid="debug-flags-user-search" type="search">' : ''
  ];
  return `<body>${parts.join('')}</body>`;
}

function webviewHostHtml(activePath: string, pendingPath?: string): string {
  return `<body><iframe id="active-frame" src="${activePath}"></iframe>
<script>
${
  pendingPath
    ? `window.loadPending = () => new Promise(resolve => {
  const next = document.createElement('iframe');
  next.id = 'pending-frame';
  next.style.visibility = 'hidden';
  next.src = '${pendingPath}';
  next.onload = () => resolve();
  document.body.appendChild(next);
});`
    : ''
}
window.promote = () => {
  document.getElementById('active-frame')?.remove();
  const next = document.getElementById('pending-frame');
  next.id = 'active-frame';
  next.style.visibility = 'visible';
};
window.dropActive = () => document.getElementById('active-frame').remove();
</script></body>`;
}

type Workbench = {
  webviews: { name: string; copy: string; hidden?: boolean; active: Content; pending?: Content }[];
};

let browser: Browser;
let server: http.Server;
let webviewOrigin: string;
let workbenchOrigin: string;
const documents = new Map<string, string>();

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://local');
  const html = documents.get(url.pathname);
  if (html === undefined) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

async function openWorkbench(page: Page, id: string, workbench: Workbench): Promise<void> {
  // Render from test-owned data before navigation; requests only select a prebuilt document.
  const frames = workbench.webviews.map(webview => {
    const contentPath = `/content/${id}/${webview.copy}`;
    const activePath = `${contentPath}/1`;
    documents.set(activePath, contentHtml(webview.copy, '1', webview.active));
    let pendingPath: string | undefined;
    if (webview.pending) {
      pendingPath = `${contentPath}/2`;
      documents.set(pendingPath, contentHtml(webview.copy, '2', webview.pending));
    }
    const hostPath = `/host/${id}/${webview.copy}`;
    documents.set(hostPath, webviewHostHtml(activePath, pendingPath));

    return (
      `<iframe class="webview" name="${webview.name}" style="visibility: ${webview.hidden ? 'hidden' : 'visible'}" ` +
      `src="${webviewOrigin}${hostPath}"></iframe>`
    );
  });
  documents.set(
    `/${id}`,
    `<body><script>window.clicked = []; addEventListener('message', e => clicked.push(e.data));</script>${frames.join('')}</body>`
  );
  await page.goto(`${workbenchOrigin}/${id}`);
  const contentFrames = workbench.webviews.length;
  await playwrightExpect
    .poll(() => page.frames().filter(frame => frame.url().startsWith(`${webviewOrigin}/content/${id}/`)).length)
    .toBe(contentFrames);
}

function host(page: Page, copy: string) {
  const frame = page
    .frames()
    .find(candidate => candidate.url().startsWith(`${webviewOrigin}/host/`) && candidate.url().endsWith(`/${copy}`));
  if (!frame) {
    throw new Error(`No webview host for ${copy}`);
  }
  return frame;
}

const logsContent: Content = { root: true, button: true, badge: false };
const noLogs: Content = { root: false, button: false, badge: false };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeAll(async () => {
  server = http.createServer(serve);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  workbenchOrigin = `http://127.0.0.1:${port}`;
  webviewOrigin = `http://localhost:${port}`;
  // Chrome ships on every GitHub-hosted runner, so the suite needs no Playwright browser download.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

let page: Page;
beforeEach(async () => {
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
});

jest.setTimeout(30_000);

describe('the Logs lookup that opens Debug Flags', () => {
  test('picks the shown copy when the hidden panel copy comes first', async () => {
    await openWorkbench(page, 'two-copies', {
      webviews: [
        { name: 'panel-webview', copy: 'panel', hidden: true, active: logsContent },
        { name: 'editor-webview', copy: 'editor', active: logsContent }
      ]
    });

    const logs = await waitForLogsDebugFlagsButton(page, 5_000);
    await logs.locator(TOOLBAR).first().click({ timeout: 5_000 });

    expect(await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked)).toEqual(['editor-v1']);
  });

  test('clicks the new content when VS Code replaces the content iframe after the lookup', async () => {
    await openWorkbench(page, 'swap', {
      webviews: [
        { name: 'panel-webview', copy: 'panel', hidden: true, active: logsContent },
        { name: 'editor-webview', copy: 'editor', active: logsContent, pending: logsContent }
      ]
    });

    const logs = await waitForLogsDebugFlagsButton(page, 5_000);
    const editorHost = host(page, 'editor');
    await editorHost.evaluate(() => (window as unknown as { loadPending: () => Promise<void> }).loadPending());
    await editorHost.evaluate(() => (window as unknown as { promote: () => void }).promote());
    await logs.locator(TOOLBAR).first().click({ timeout: 5_000 });

    expect(await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked)).toEqual(['editor-v2']);
  });

  test('one call waits while the content is pending and returns it once VS Code promotes it', async () => {
    await openWorkbench(page, 'pending', {
      webviews: [
        {
          name: 'editor-webview',
          copy: 'editor',
          active: { ...logsContent, button: false },
          pending: logsContent
        }
      ]
    });
    const editorHost = host(page, 'editor');
    await editorHost.evaluate(() => (window as unknown as { loadPending: () => Promise<void> }).loadPending());

    let settled = false;
    const lookup = waitForLogsDebugFlagsButton(page, 10_000).finally(() => {
      settled = true;
    });
    await sleep(1_500);
    expect(settled).toBe(false);

    await editorHost.evaluate(() => (window as unknown as { promote: () => void }).promote());
    const logs = await lookup;
    await logs.locator(TOOLBAR).first().click({ timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked)).toEqual(['editor-v2']);
  });
});

describe('shownWebview', () => {
  test('gives up once its timeout has passed', async () => {
    await openWorkbench(page, 'deadline', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });

    const started = Date.now();
    await expect(shownWebview(page, '[data-testid="absent"]', 10)).rejects.toThrow('within 10 ms');
    expect(Date.now() - started).toBeLessThan(200);
  });

  type Poll = { start: number; end: number };

  /**
   * Records every poll of `shownWebview` on the workbench page. Each poll lists the outer iframes with one
   * `getComputedStyle` call per iframe in the page's main world, so with one webview each call is one poll. When
   * `holdFirstPollMs` is set, the first poll keeps the page busy for that long, measured from its own start.
   */
  async function recordPolls(holdFirstPollMs = 0): Promise<() => Promise<Poll[]>> {
    await page.evaluate(holdMs => {
      const w = window as unknown as { polls: Poll[] };
      w.polls = [];
      const original = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element: Element, pseudo?: string | null) => {
        const start = Date.now();
        if (w.polls.length === 0 && holdMs > 0) {
          while (Date.now() < start + holdMs) {
            // Busy: the poll is in progress.
          }
        }
        w.polls.push({ start, end: Date.now() });
        return original(element, pseudo);
      };
    }, holdFirstPollMs);
    return () => page.evaluate(() => (window as unknown as { polls: Poll[] }).polls);
  }

  const CUTOFF_MS = 2_000;

  test('lets the poll in progress at the cutoff return the webview it finds', async () => {
    await openWorkbench(page, 'late-hit', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });
    const polls = await recordPolls(CUTOFF_MS + 500);

    const before = Date.now();
    const logs = await shownWebview(page, TOOLBAR, CUTOFF_MS);
    const recorded = await polls();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.start).toBeLessThan(before + CUTOFF_MS);
    expect(recorded[0]!.end).toBeGreaterThan(before + CUTOFF_MS);
    await playwrightExpect(logs.locator(TOOLBAR)).toBeVisible({ timeout: 5_000 });
  });

  test('starts no poll after the poll in progress at the cutoff ends empty', async () => {
    await openWorkbench(page, 'late-miss', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });
    const polls = await recordPolls(CUTOFF_MS + 500);

    const before = Date.now();
    await expect(shownWebview(page, '[data-testid="absent"]', CUTOFF_MS)).rejects.toThrow(`within ${CUTOFF_MS} ms`);
    const recorded = await polls();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.start).toBeLessThan(before + CUTOFF_MS);
    expect(recorded[0]!.end).toBeGreaterThan(before + CUTOFF_MS);
  });

  test('waits for the cutoff after a poll that ends empty before it, and rejects without another poll', async () => {
    await openWorkbench(page, 'early-miss', {
      webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }]
    });
    const polls = await recordPolls();

    // Shorter than the 250 ms poll interval, so the poll that ends empty is followed by the sleep to the cutoff.
    const cutoffMs = 240;
    const before = Date.now();
    await expect(shownWebview(page, '[data-testid="absent"]', cutoffMs)).rejects.toThrow(`within ${cutoffMs} ms`);
    const rejectedAt = Date.now();
    const recorded = await polls();

    expect(recorded).toHaveLength(1);
    expect(rejectedAt).toBeGreaterThanOrEqual(before + cutoffMs);
  });
});

describe('webviewWith', () => {
  test('rejects a test id that two webviews hold, even when one of them is hidden', async () => {
    await openWorkbench(page, 'ambiguous', {
      webviews: [
        { name: 'panel-webview', copy: 'panel', hidden: true, active: logsContent },
        { name: 'editor-webview', copy: 'editor', active: logsContent }
      ]
    });

    await expect(webviewWith(page, 'logs-open-debug-flags').locator(TOOLBAR).click({ timeout: 5_000 })).rejects.toThrow(
      'matched elements in multiple frames'
    );
    expect(await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked)).toEqual([]);
  });
});

describe('the Debug Flags editor lookup', () => {
  test('finds the editor by its user search', async () => {
    await openWorkbench(page, 'flags', {
      webviews: [{ name: 'flags-webview', copy: 'flags', active: { ...noLogs, orgSelect: true, userSearch: true } }]
    });

    const flags = await waitForDebugFlagsFrame(page, 5_000);
    await playwrightExpect(flags.getByTestId('debug-flags-org-select')).toHaveText('default-org');
  });

  test('does not accept a document that shows only the org select', async () => {
    await openWorkbench(page, 'org-only', {
      webviews: [{ name: 'flags-webview', copy: 'flags', active: { ...noLogs, orgSelect: true } }]
    });

    await expect(waitForDebugFlagsFrame(page, 1_000)).rejects.toThrow();
  });
});

describe('expectWebviewWithout', () => {
  const absentBadge = { timeout: 1_000 };

  test('passes when the webview is there without the element', async () => {
    await openWorkbench(page, 'no-badge', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });

    await expectWebviewWithout(
      webviewWith(page, 'logs-errors-only-switch'),
      '[data-testid="logs-error-badge"]',
      absentBadge
    );
  });

  test('fails when the webview holds the element', async () => {
    await openWorkbench(page, 'badge', {
      webviews: [{ name: 'logs-webview', copy: 'logs', active: { ...logsContent, badge: true } }]
    });

    await expect(
      expectWebviewWithout(
        webviewWith(page, 'logs-errors-only-switch'),
        '[data-testid="logs-error-badge"]',
        absentBadge
      )
    ).rejects.toThrow();
  });

  test('fails when the webview content is gone, where a bare zero count passes', async () => {
    await openWorkbench(page, 'gone', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });
    await host(page, 'logs').evaluate(() => (window as unknown as { dropActive: () => void }).dropActive());
    const logs = webviewWith(page, 'logs-errors-only-switch');

    await playwrightExpect(logs.locator('[data-testid="logs-error-badge"]')).toHaveCount(0, absentBadge);
    await expect(expectWebviewWithout(logs, '[data-testid="logs-error-badge"]', absentBadge)).rejects.toThrow();
  });
});
