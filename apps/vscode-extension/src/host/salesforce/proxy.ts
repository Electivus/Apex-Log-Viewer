import * as vscode from 'vscode';
import { configureSalesforceProxy, type SalesforceProxySettings } from '@alv/core';
import { affectsConfiguration, getConfig } from '../utils/config';
import { logWarn } from '../utils/logger';

const PROXY_SETTINGS = ['http.proxy', 'http.noProxy', 'http.proxySupport'];

function readProxySettings(): SalesforceProxySettings {
  if (getConfig<unknown>('http.proxySupport', 'override') === 'off') {
    return {};
  }
  const proxyUrl = getConfig<unknown>('http.proxy', '');
  const noProxy = getConfig<unknown>('http.noProxy', []);
  return {
    proxyUrl: typeof proxyUrl === 'string' ? proxyUrl : undefined,
    noProxy: Array.isArray(noProxy) ? noProxy.filter((entry): entry is string => typeof entry === 'string') : undefined
  };
}

function applyProxySettings(): void {
  if (configureSalesforceProxy(readProxySettings()) === 'ignored-proxy-url') {
    logWarn(
      'Salesforce requests cannot use the http.proxy setting, so they use HTTPS_PROXY or HTTP_PROXY, or go direct.'
    );
  }
}

/**
 * VS Code applies `http.proxy` and `http.noProxy` by patching Node's `http`, `https` and global `fetch`. jsforce sends
 * through the `undici` package's own `fetch`, bundled into the extension, which none of those patches reach.
 */
export function registerSalesforceProxy(): vscode.Disposable {
  applyProxySettings();
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (PROXY_SETTINGS.some(name => affectsConfiguration(event, name))) {
      applyProxySettings();
    }
  });
}
