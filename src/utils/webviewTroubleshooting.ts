import * as os from 'node:os';
import * as path from 'node:path';

type WebviewTroubleshootingOptions = {
  appName?: string;
  appData?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

type LocalUiWebviewCachePaths = {
  windows: string;
  macos: string;
  linux: string;
};

function getCodeProfileFolder(appName?: string): string {
  const label = appName?.trim();
  if (!label) {
    return 'Code';
  }

  const normalized = label.toLowerCase();
  if (
    normalized === 'code - insiders' ||
    normalized === 'visual studio code - insiders' ||
    normalized === 'vscode - insiders'
  ) {
    return 'Code - Insiders';
  }

  if (normalized === 'code' || normalized === 'visual studio code' || normalized === 'vs code') {
    return 'Code';
  }

  return label;
}

export function getRemoteEnvironmentLabel(remoteName?: string): string {
  const normalized = remoteName?.trim().toLowerCase();
  switch (normalized) {
    case 'wsl':
      return 'WSL';
    case 'ssh-remote':
      return 'SSH';
    case 'dev-container':
      return 'a Dev Container';
    case 'codespaces':
      return 'Codespaces';
    default:
      return remoteName?.trim() || 'a remote workspace';
  }
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

export function getLocalUiWebviewCachePaths(appName?: string): LocalUiWebviewCachePaths {
  const profileFolder = getCodeProfileFolder(appName);
  return {
    windows: `%APPDATA%\\${profileFolder}\\Service Worker`,
    macos: `~/Library/Application Support/${profileFolder}/Service Worker`,
    linux: `~/.config/${profileFolder}/Service Worker`
  };
}

export function buildWebviewTroubleshootingMessage(appName: string | undefined, serviceWorkerPath: string): string {
  const label = appName?.trim() || 'VS Code';
  return `If an Apex Logs view fails with "Could not register service worker", close all ${label} windows, delete the webview cache at ${serviceWorkerPath}, and reopen the IDE. This is a VS Code webview-host issue, not the extension CLI cache.`;
}

export function buildRemoteWebviewTroubleshootingMessage(
  appName: string | undefined,
  remoteName: string | undefined,
  cachePaths: LocalUiWebviewCachePaths
): string {
  const label = appName?.trim() || 'VS Code';
  const remoteLabel = getRemoteEnvironmentLabel(remoteName);
  return `If an Apex Logs view fails with "Could not register service worker" while connected to ${remoteLabel}, close all ${label} windows on your local machine and clear the webview cache from the local VS Code UI host.\n\nWindows: ${cachePaths.windows}\nmacOS: ${cachePaths.macos}\nLinux: ${cachePaths.linux}\n\nThis cache is local to the VS Code UI machine, not the remote extension host or the extension CLI cache.`;
}
