// jsforce sets its request defaults when its transport module loads. Loading it first makes ours the ones that stay.
import '@jsforce/jsforce-node/lib/transport';
import { setDefaults, setDispatcher } from '@jsforce/jsforce-node/lib/request';
import { EnvHttpProxyAgent } from 'undici';

/** How Salesforce requests reach the org, on top of the process environment. */
export type SalesforceProxySettings = {
  /** A proxy URL, credentials allowed, for every Salesforce request. Blank or absent: HTTPS_PROXY and HTTP_PROXY decide. */
  proxyUrl?: string;
  /** Hosts that skip the proxy, in NO_PROXY syntax. Non-empty: replaces NO_PROXY. Empty or absent: NO_PROXY decides. */
  noProxy?: readonly string[];
};

let installed: EnvHttpProxyAgent | undefined;

/**
 * Routes every Salesforce request of this process, from each jsforce connection and each token refresh. jsforce
 * builds a proxy agent from HTTPS_PROXY for each request and ignores NO_PROXY; this replaces it with one agent that
 * honors both. Calling it again replaces the route for the next request. A `proxyUrl` the agent cannot use is ignored
 * for the environment, as VS Code ignores it, and so is an unusable environment proxy.
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
