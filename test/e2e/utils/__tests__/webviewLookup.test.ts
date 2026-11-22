import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { waitForDebugFlagsFrame, waitForLogsDebugFlagsButton } from '../../specs/debugFlagsPanel.shared';
import { expectWebviewWithout, shownWebview, systemClock, webviewWith, type LookupClock } from '../webviews';

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
   * time, and a log of what the helper did, in order. Time moves only when a poll returns (by `pollMs`) and when a
   * sleep wakes (by what it asked for plus `lateMs`, a timer that fires late). A sleep wakes on a later macrotask, not
   * when it is requested, so a clock read between the request and the wake still sees the old time. Polls are counted
   * in Node: `watched` is the page with its `iframe.webview` lookup wrapped, which is how each poll lists the outer
   * iframes. A sleep past 20 rejects, so a helper that never stops fails instead of hanging.
   */
  async function deadlineBench(id: string, { pollMs, lateMs = 0 }: { pollMs: number; lateMs?: number }) {
    let time = 0;
    let sleeps = 0;
    const events: string[] = [];
    const clock: LookupClock = {
      now: () => {
        events.push(`read ${time}`);
        return time;
      },
      sleep: ms => {
        events.push(`sleep ${ms}`);
        sleeps += 1;
        if (sleeps > 20) {
          return Promise.reject(new Error('runaway: the helper kept sleeping past 20 sleeps'));
        }
        return new Promise(resolve =>
          setImmediate(() => {
            time += ms + lateMs;
            events.push(`wake ${time}`);
            resolve();
          })
        );
      }
    };
    await openWorkbench(page, id, { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });
    const watched = new Proxy(page, {
      get(target, prop) {
        if (prop === 'locator') {
          return (selector: string, options?: Parameters<Page['locator']>[1]) => {
            const locator = target.locator(selector, options);
            if (selector !== 'iframe.webview') {
              return locator;
            }
            return new Proxy(locator, {
              get(inner, key) {
                if (key === 'evaluateAll') {
                  return async (...args: Parameters<typeof inner.evaluateAll>) => {
                    const result = await inner.evaluateAll(...args);
                    time += pollMs;
                    events.push(`poll ${time}`);
                    return result;
                  };
                }
                const value = Reflect.get(inner, key);
                return typeof value === 'function' ? value.bind(inner) : value;
              }
            });
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Page;
    return { clock, watched, events, time: () => time };
  }

  async function outcome(promise: Promise<unknown>, bench: { events: string[] }) {
    return await promise.then(
      () => 'resolved',
      (error: Error) => {
        bench.events.push('reject');
        return error.message;
      }
    );
  }

  test('returns the webview found by the poll still running when the cutoff passes', async () => {
    const bench = await deadlineBench('late-hit', { pollMs: 150 });

    const logs = await shownWebview(bench.watched, TOOLBAR, 100, bench.clock);

    expect(bench.events).toEqual(['read 0', 'poll 150']);
    await playwrightExpect(logs.locator(TOOLBAR)).toBeVisible({ timeout: 5_000 });
  });

  describe.each([0, 220, 600])('with the sleep timer firing %i ms late', lateMs => {
    test('rejects after the poll still running at the cutoff ends empty, with no wait and no other poll', async () => {
      const bench = await deadlineBench('late-miss', { pollMs: 150, lateMs });

      const message = await outcome(shownWebview(bench.watched, '[data-testid="absent"]', 100, bench.clock), bench);

      expect(message).toContain('within 100 ms');
      const woke = 150 + lateMs;
      expect(bench.events).toEqual([
        'read 0',
        'poll 150',
        'read 150',
        'sleep 0',
        `wake ${woke}`,
        `read ${woke}`,
        'reject'
      ]);
    });

    test('sleeps until the cutoff after a poll ends empty with less than 250 ms left, then rejects', async () => {
      const bench = await deadlineBench('short-left', { pollMs: 10, lateMs });

      const message = await outcome(shownWebview(bench.watched, '[data-testid="absent"]', 100, bench.clock), bench);

      expect(message).toContain('within 100 ms');
      const woke = 100 + lateMs;
      expect(bench.events).toEqual([
        'read 0',
        'poll 10',
        'read 10',
        'sleep 90',
        `wake ${woke}`,
        `read ${woke}`,
        'reject'
      ]);
    });

    test('sleeps exactly 250 ms when 250 ms are left, then rejects', async () => {
      const bench = await deadlineBench('exact-left', { pollMs: 10, lateMs });

      const message = await outcome(shownWebview(bench.watched, '[data-testid="absent"]', 260, bench.clock), bench);

      expect(message).toContain('within 260 ms');
      const woke = 260 + lateMs;
      expect(bench.events).toEqual([
        'read 0',
        'poll 10',
        'read 10',
        'sleep 250',
        `wake ${woke}`,
        `read ${woke}`,
        'reject'
      ]);
    });
  });

  test.each([
    {
      lateMs: 0,
      // Wakes at 260 and 520, before the 600 ms cutoff, so it polls again each time; the last sleep is the 70 ms left.
      events: [
        'read 0',
        'poll 10',
        'read 10',
        'sleep 250',
        'wake 260',
        'read 260',
        'poll 270',
        'read 270',
        'sleep 250',
        'wake 520',
        'read 520',
        'poll 530',
        'read 530',
        'sleep 70',
        'wake 600',
        'read 600',
        'reject'
      ]
    },
    {
      lateMs: 220,
      // Wakes at 480, before the cutoff: one more poll, then the 110 ms left.
      events: [
        'read 0',
        'poll 10',
        'read 10',
        'sleep 250',
        'wake 480',
        'read 480',
        'poll 490',
        'read 490',
        'sleep 110',
        'wake 820',
        'read 820',
        'reject'
      ]
    },
    {
      lateMs: 600,
      // Wakes at 860, past the cutoff: no other poll.
      events: ['read 0', 'poll 10', 'read 10', 'sleep 250', 'wake 860', 'read 860', 'reject']
    }
  ])(
    'requests a 250 ms sleep and polls again only if it wakes before the cutoff (timer $lateMs ms late)',
    async ({ lateMs, events }) => {
      const bench = await deadlineBench('long-left', { pollMs: 10, lateMs });

      const message = await outcome(shownWebview(bench.watched, '[data-testid="absent"]', 600, bench.clock), bench);

      expect(message).toContain('within 600 ms');
      expect(bench.events).toEqual(events);
    }
  );

  test('rejects a missing selector with the default clock', async () => {
    await openWorkbench(page, 'deadline', { webviews: [{ name: 'logs-webview', copy: 'logs', active: logsContent }] });

    await expect(shownWebview(page, '[data-testid="absent"]', 10)).rejects.toThrow('within 10 ms');
  });

  test('the default clock reads Date.now and sleeps for exactly the time asked', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      expect(systemClock.now()).toBe(1_000_000);
      jest.setSystemTime(1_000_250);
      expect(systemClock.now()).toBe(1_000_250);

      let woke = false;
      void systemClock.sleep(250).then(() => {
        woke = true;
      });
      await jest.advanceTimersByTimeAsync(249);
      expect(woke).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(woke).toBe(true);
    } finally {
      jest.useRealTimers();
    }
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
