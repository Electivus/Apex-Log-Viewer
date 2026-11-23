// Build with `pnpm run build:webview`, then run this file with `node --test`.
// CHROME_PATH selects a Chromium executable; otherwise use Playwright Chromium.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

const media = process.env.TAIL_MEDIA_DIR ?? path.resolve('apps/vscode-extension/media');

test('native End keeps rows in view while the paused Tail moves to the end', { timeout: 15_000 }, async () => {
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }
  );
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(
      '<style>body{margin:0}</style><div id="root" style="display:flex;flex-direction:column;height:100vh"></div>'
    );
    await page.addStyleTag({ path: path.join(media, 'webview.css') });
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({ getState: () => ({ autoScroll: true }), setState() {}, postMessage() {} });
    });
    await page.addScriptTag({ path: path.join(media, 'tail.js') });
    const follow = page.getByRole('switch', { name: 'Auto-scroll' });
    const list = page.getByRole('list');
    await follow.waitFor();
    await page.evaluate(() => {
      const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
      send({ type: 'tailConfig', tailBufferSize: 1000 });
      send({
        type: 'tailData',
        lines: Array.from({ length: 1000 }, (_, i) =>
          i >= 430 && i <= 454 ? `Line ${i} ${'wrapped words go here '.repeat(22)}` : `Line ${i} short`
        )
      });
    });
    await page.getByText('Line 999 short').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('[role="list"]');
      return el && el.scrollTop === el.scrollHeight - el.clientHeight;
    });
    await follow.click();
    assert.equal(await follow.getAttribute('aria-checked'), 'false');
    await list.evaluate(el => {
      const height = Math.ceil(el.querySelector('[role="row"]').getBoundingClientRect().height);
      el.scrollTop = 450 * height;
    });
    await list.locator('[data-line-seq="440"]').waitFor();
    await list.focus();

    await list.evaluate(el => {
      // ResizeObserver runs after animation-frame callbacks and layout, before paint.
      // Resizing an invisible element lets it sample even when no Tail row changes size.
      const sensor = document.createElement('div');
      sensor.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:1px';
      document.body.append(sensor);
      const samples = [];
      let frame = 0;
      let width = 1;
      const tick = () => {
        width = 3 - width;
        sensor.style.width = `${width}px`;
        frame = requestAnimationFrame(tick);
      };
      const observer = new ResizeObserver(() => {
        const viewport = el.getBoundingClientRect();
        const rows = Array.from(el.querySelectorAll('[role="row"]'), row => row.getBoundingClientRect());
        samples.push({
          top: el.scrollTop,
          mounted: rows.length,
          visible: rows.some(row => row.bottom > viewport.top && row.top < viewport.bottom)
        });
      });
      observer.observe(sensor);
      tick();
      window.stopSampling = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        sensor.remove();
        return samples;
      };
    });
    const start = await list.evaluate(el => el.scrollTop);
    await page.keyboard.press('End');
    await page.getByText('Line 999 short').waitFor();
    const end = await list.evaluate(async el => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { top: el.scrollTop, limit: el.scrollHeight - el.clientHeight };
    });
    const samples = await page.evaluate(() => window.stopSampling());

    assert.ok(end.top > start, 'End must move the native scroll offset');
    assert.equal(end.top, end.limit, 'End must reach the bottom');
    assert.equal(await follow.getAttribute('aria-checked'), 'false');
    assert.ok(
      samples.some(sample => sample.top > start),
      'must sample during the scroll'
    );
    assert.ok(
      samples.every(sample => sample.mounted < 100),
      'the row window must stay bounded'
    );
    assert.deepEqual(
      samples.filter(sample => !sample.visible),
      [],
      'no frame should be missing all rows'
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
