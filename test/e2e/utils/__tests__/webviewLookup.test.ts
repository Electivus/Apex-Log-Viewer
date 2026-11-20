import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { waitForLogsDebugFlagsButton } from '../../specs/debugFlagsPanel.shared';
import { expectWebviewWithout, webviewWith } from '../webviews';

/**
 * A synthetic workbench shaped like VS Code's: each webview is an `iframe.webview` named by its id, whose page holds the
 * content in `iframe#active-frame`. New content loads into a hidden `#pending-frame`, which replaces the active one when
 * promoted. The page and the webviews are served from two origins, so Chromium puts them out of process like VS Code.
 */

const TOOLBAR = '[data-testid="logs-open-debug-flags"]';

type Content = { root: boolean; button: boolean; badge: boolean };

function contentHtml(copy: string, version: string, content: Content): string {
  const parts = [
    content.root ? '<div data-testid="logs-errors-only-switch">Errors only</div>' : '',
    content.button
      ? `<button data-testid="logs-open-debug-flags" onclick="top.postMessage('${copy}-v${version}', '*')">Debug flags</button>`
      : '',
    content.badge ? '<span data-testid="logs-error-badge">Error</span>' : ''
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

  test('does not settle on hidden pending content, and finds it once VS Code promotes it', async () => {
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

    await expect(waitForLogsDebugFlagsButton(page, 1_500)).rejects.toThrow();

    await editorHost.evaluate(() => (window as unknown as { promote: () => void }).promote());
    const logs = await waitForLogsDebugFlagsButton(page, 5_000);
    await logs.locator(TOOLBAR).first().click({ timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked)).toEqual(['editor-v2']);
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
