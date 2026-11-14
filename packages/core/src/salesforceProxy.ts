// jsforce sets its request defaults when its transport module loads. Loading it first makes ours the ones that stay.
import '@jsforce/jsforce-node/lib/transport';
import { setDefaults, setDispatcher } from '@jsforce/jsforce-node/lib/request';
import { EnvHttpProxyAgent } from 'undici';

export type SalesforceProxySettings = {
  /** A proxy URL, credentials allowed, for http and https requests. Blank or absent: HTTPS_PROXY and HTTP_PROXY decide. */
  proxyUrl?: string;
  /** Hosts that skip the proxy, in NO_PROXY syntax. Non-empty: replaces NO_PROXY. Empty or absent: NO_PROXY decides. */
  noProxy?: readonly string[];
};

let installed: EnvHttpProxyAgent | undefined;

/**
 * Routes every jsforce request of this process, connection calls and token refreshes alike, through one agent that
 * honors NO_PROXY. jsforce otherwise builds a proxy agent per request from the proxy variables and ignores NO_PROXY.
 * CometD streaming runs on Faye and is not covered. Calling it again replaces the route for the next request. A
 * `proxyUrl` the agent rejects falls back to the environment and returns `'ignored-proxy-url'`; a rejected environment
 * proxy falls back to a direct connection.
 */
export function configureSalesforceProxy(settings: SalesforceProxySettings = {}): 'ignored-proxy-url' | undefined {
  const noProxy = settings.noProxy?.length ? settings.noProxy.join(',') : undefined;
  const proxyUrl = settings.proxyUrl?.trim();
  const fromSettings = proxyUrl ? tryAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy }) : undefined;
  const agent =
    fromSettings ??
    tryAgent({ noProxy }) ??
    new EnvHttpProxyAgent({ allowH2: false, httpProxy: '', httpsProxy: '', noProxy });

  setDefaults({
    timeout: process.env.HTTP_TIMEOUT ? parseInt(process.env.HTTP_TIMEOUT, 10) : undefined,
    followRedirect: true
  });
  setDispatcher(agent);
  const previous = installed;
  installed = agent;
  void previous?.close().catch(() => undefined);

  return proxyUrl && !fromSettings ? 'ignored-proxy-url' : undefined;
}

function tryAgent(options: {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}): EnvHttpProxyAgent | undefined {
  try {
    return new EnvHttpProxyAgent({ allowH2: false, ...options });
  } catch {
    return undefined;
  }
}

configureSalesforceProxy();
