import assert from 'assert/strict';
import path from 'node:path';
import {
  buildRemoteWebviewTroubleshootingMessage,
  buildWebviewTroubleshootingMessage,
  getLocalUiWebviewCachePaths,
  getWebviewServiceWorkerPath
} from '../utils/webviewTroubleshooting';

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

  test('maps the Visual Studio Code app name back to the stable profile folder', () => {
    const target = getWebviewServiceWorkerPath({
      appName: 'Visual Studio Code',
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

  test('preserves non-Microsoft build names when resolving the cache path', () => {
    const vscodiumTarget = getWebviewServiceWorkerPath({
      appName: 'VSCodium',
      platform: 'linux',
      homeDir: '/home/k2'
    });
    const ossTarget = getWebviewServiceWorkerPath({
      appName: 'Code - OSS',
      platform: 'win32',
      appData: 'C:\\Users\\k2\\AppData\\Roaming',
      homeDir: 'C:\\Users\\k2'
    });

    assert.equal(vscodiumTarget, path.posix.join('/home/k2', '.config', 'VSCodium', 'Service Worker'));
    assert.equal(ossTarget, 'C:\\Users\\k2\\AppData\\Roaming\\Code - OSS\\Service Worker');
  });

  test('builds local UI cache paths without using the remote extension host filesystem', () => {
    const cachePaths = getLocalUiWebviewCachePaths('Code - Insiders');

    assert.deepEqual(cachePaths, {
      windows: '%APPDATA%\\Code - Insiders\\Service Worker',
      macos: '~/Library/Application Support/Code - Insiders/Service Worker',
      linux: '~/.config/Code - Insiders/Service Worker'
    });
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

  test('builds a remote troubleshooting message with local UI cache locations', () => {
    const message = buildRemoteWebviewTroubleshootingMessage('Code - Insiders', 'WSL', {
      windows: '%APPDATA%\\Code - Insiders\\Service Worker',
      macos: '~/Library/Application Support/Code - Insiders/Service Worker',
      linux: '~/.config/Code - Insiders/Service Worker'
    });

    assert.match(message, /while connected to WSL/);
    assert.match(message, /Windows: %APPDATA%\\Code - Insiders\\Service Worker/);
    assert.match(message, /macOS: ~\/Library\/Application Support\/Code - Insiders\/Service Worker/);
    assert.match(message, /Linux: ~\/\.config\/Code - Insiders\/Service Worker/);
    assert.match(message, /local to the VS Code UI machine/);
  });
});
