import * as vscode from 'vscode';
import { configureSalesforceProxy, type SalesforceProxySettings } from '@alv/core';
import { affectsConfiguration, getConfig } from '../utils/config';
import { logWarn } from '../utils/logger';

const PROXY_SETTINGS = ['http.proxy', 'http.noProxy', 'http.proxySupport'];

/**
 * VS Code's proxy settings for extension traffic. VS Code applies them by patching Node's `http` and `https`, which
 * jsforce's own fetch never calls. `off` turns that support off, so requests follow the environment, as in the CLI.
 */
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

/** Sends Salesforce requests through VS Code's proxy settings now and after every change to them. */
export function registerSalesforceProxy(): vscode.Disposable {
  applyProxySettings();
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (PROXY_SETTINGS.some(name => affectsConfiguration(event, name))) {
      applyProxySettings();
    }
  });
}
