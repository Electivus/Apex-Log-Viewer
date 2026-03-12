import assert from 'assert/strict';
import path from 'node:path';
import { buildWebviewTroubleshootingMessage, getWebviewServiceWorkerPath } from '../utils/webviewTroubleshooting';

suite('webview troubleshooting', () => {
  test('uses the Insiders profile path on Windows', () => {
    const target = getWebviewServiceWorkerPath({
      appName: 'Code - Insiders',
      platform: 'win32',
      appData: 'C:\\Users\\k2\\AppData\\Roaming',
      homeDir: 'C:\\Users\\k2'
    });

    assert.equal(target, 'C:\\Users\\k2\\AppData\\Roaming\\Code - Insiders\\Service Worker');
  });

  test('uses the stable profile path on Linux', () => {
    const target = getWebviewServiceWorkerPath({
      appName: 'Code',
      platform: 'linux',
      homeDir: '/home/k2'
    });

    assert.equal(target, path.posix.join('/home/k2', '.config', 'Code', 'Service Worker'));
  });

  test('uses the Insiders profile path on macOS', () => {
    const target = getWebviewServiceWorkerPath({
      appName: 'Visual Studio Code - Insiders',
      platform: 'darwin',
      homeDir: '/Users/k2'
    });

    assert.equal(
      target,
      path.posix.join('/Users/k2', 'Library', 'Application Support', 'Code - Insiders', 'Service Worker')
    );
  });

  test('builds a troubleshooting message with the app label and cache path', () => {
    const message = buildWebviewTroubleshootingMessage(
      'Code - Insiders',
      'C:\\Users\\k2\\AppData\\Roaming\\Code - Insiders\\Service Worker'
    );

    assert.match(message, /Code - Insiders/);
    assert.match(message, /Service Worker/);
    assert.match(message, /not the extension CLI cache/);
  });
});
