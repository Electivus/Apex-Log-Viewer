import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { waitForDebugFlagsFrame, waitForLogsDebugFlagsButton } from '../../specs/debugFlagsPanel.shared';
import { expectWebviewWithout, shownWebview, webviewWith, type LookupClock } from '../webviews';

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
  /**
   * A fake clock for `shownWebview`, so the tests read the deadline from the clock the helper reads, not from wall
   * time. Time moves only when the helper sleeps (by what it asks for plus `lateMs`, a timer that fires late) and when
   * the workbench page runs a poll (by `pollMs`). Each poll lists the outer iframes with one `getComputedStyle` call
   * per iframe in the page's main world; with one webview, the wrapper below reports each call as one poll. It then
   * keeps the page busy for 100 ms, so the report reaches the test before the poll's result reaches the helper.
   */
  async function deadlineBench(id: string, { pollMs, lateMs = 0 }: { pollMs: number; lateMs?: number }) {
    let time = 0;
    let polls = 0;
    const sleeps: number[] = [];
    const clock: LookupClock = {
      now: () => time,
      sleep: async ms => {
        sleeps.push(ms);
        if (sleeps.length > 20) {
          throw new Error('runaway: the helper kept sleeping past 20 sleeps');
        }
        time += ms + lateMs;
      }
    };
    await page.exposeFunction('reportPoll', () => {
      polls += 1;
      time += pollMs;
    });
    await openWorkbench(page, id, { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });
    await page.evaluate(() => {
      const original = window.getComputedStyle.bind(window);
      const report = (window as unknown as { reportPoll: () => void }).reportPoll;
      window.getComputedStyle = (element: Element, pseudo?: string | null) => {
        void report();
        const end = Date.now() + 100;
        while (Date.now() < end) {
          // Busy, so the report is delivered before the poll returns.
        }
        return original(element, pseudo);
      };
    });
    return {
      clock,
      result: () => ({ polls, sleeps: [...sleeps], time })
    };
  }

  async function rejection(promise: Promise<unknown>, bench: { result: () => { time: number } }) {
    return await promise.then(
      () => 'resolved',
      (error: Error) => ({ message: error.message, at: bench.result().time })
    );
  }

  test('returns the webview found by the poll still running when the cutoff passes', async () => {
    const bench = await deadlineBench('late-hit', { pollMs: 150 });

    const logs = await shownWebview(page, TOOLBAR, 100, bench.clock);

    expect(bench.result()).toEqual({ polls: 1, sleeps: [], time: 150 });
    await playwrightExpect(logs.locator(TOOLBAR)).toBeVisible({ timeout: 5_000 });
  });

  describe.each([0, 220, 600])('with the sleep timer firing %i ms late', lateMs => {
    test('rejects after the poll still running at the cutoff ends empty, with no wait and no other poll', async () => {
      const bench = await deadlineBench('late-miss', { pollMs: 150, lateMs });

      const outcome = await rejection(shownWebview(page, '[data-testid="absent"]', 100, bench.clock), bench);

      expect(outcome).toEqual({ message: expect.stringContaining('within 100 ms'), at: 150 + lateMs });
      expect(bench.result()).toMatchObject({ polls: 1, sleeps: [0] });
    });

    test('sleeps until the cutoff after a poll ends empty with less than 250 ms left, then rejects', async () => {
      const bench = await deadlineBench('short-left', { pollMs: 10, lateMs });

      const outcome = await rejection(shownWebview(page, '[data-testid="absent"]', 100, bench.clock), bench);

      expect(outcome).toEqual({ message: expect.stringContaining('within 100 ms'), at: 100 + lateMs });
      expect(bench.result()).toMatchObject({ polls: 1, sleeps: [90] });
    });

    test('sleeps exactly 250 ms when 250 ms are left, then rejects', async () => {
      const bench = await deadlineBench('exact-left', { pollMs: 10, lateMs });

      const outcome = await rejection(shownWebview(page, '[data-testid="absent"]', 260, bench.clock), bench);

      expect(outcome).toEqual({ message: expect.stringContaining('within 260 ms'), at: 260 + lateMs });
      expect(bench.result()).toMatchObject({ polls: 1, sleeps: [250] });
    });
  });

  test.each([
    // Polls at 0, 260 and 520 (each takes 10 ms); sleeps 250, 250, then the 70 ms left; rejects at 600.
    { lateMs: 0, polls: 3, sleeps: [250, 250, 70], at: 600 },
    // The first sleep ends at 480: one more poll, then the 110 ms left, ending at 820.
    { lateMs: 220, polls: 2, sleeps: [250, 110], at: 820 },
    // The first sleep ends at 860, past the cutoff: no other poll.
    { lateMs: 600, polls: 1, sleeps: [250], at: 860 }
  ])(
    'polls again every 250 ms while more than 250 ms are left (timer $lateMs ms late)',
    async ({ lateMs, polls, sleeps, at }) => {
      const bench = await deadlineBench('long-left', { pollMs: 10, lateMs });

      const outcome = await rejection(shownWebview(page, '[data-testid="absent"]', 600, bench.clock), bench);

      expect(outcome).toEqual({ message: expect.stringContaining('within 600 ms'), at });
      expect(bench.result()).toMatchObject({ polls, sleeps });
    }
  );

  test('gives up on the system clock once its timeout has passed', async () => {
    await openWorkbench(page, 'deadline', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });

    await expect(shownWebview(page, '[data-testid="absent"]', 10)).rejects.toThrow('within 10 ms');
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
