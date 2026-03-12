import * as os from 'node:os';
import * as path from 'node:path';

type WebviewTroubleshootingOptions = {
  appName?: string;
  appData?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

function getCodeProfileFolder(appName?: string): string {
  const normalized = appName?.toLowerCase() ?? '';
  if (normalized.includes('insider')) {
    return 'Code - Insiders';
  }
  return 'Code';
}

export function getWebviewServiceWorkerPath(options: WebviewTroubleshootingOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const profileFolder = getCodeProfileFolder(options.appName);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    const appData = options.appData ?? process.env.APPDATA ?? pathApi.join(homeDir, 'AppData', 'Roaming');
    return pathApi.join(appData, profileFolder, 'Service Worker');
  }

  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Application Support', profileFolder, 'Service Worker');
  }

  return pathApi.join(homeDir, '.config', profileFolder, 'Service Worker');
}

export function buildWebviewTroubleshootingMessage(appName: string | undefined, serviceWorkerPath: string): string {
  const label = appName?.trim() || 'VS Code';
  return `If an Apex Logs view fails with "Could not register service worker", close all ${label} windows, delete the webview cache at ${serviceWorkerPath}, and reopen the IDE. This is a VS Code webview-host issue, not the extension CLI cache.`;
}
