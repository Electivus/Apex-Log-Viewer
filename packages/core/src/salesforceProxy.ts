// jsforce sets its request defaults when its transport module loads. Loading it first makes ours the ones that stay.
import '@jsforce/jsforce-node/lib/transport';
import { setDefaults, setDispatcher } from '@jsforce/jsforce-node/lib/request';
import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from 'undici';

import { AlvError } from './errors.js';

export type SalesforceProxySettings = {
  /** A proxy URL, credentials allowed, for http and https requests. Blank or absent: HTTPS_PROXY and HTTP_PROXY decide. */
  proxyUrl?: string;
  /** Hosts that skip the proxy, in NO_PROXY syntax. Non-empty: replaces NO_PROXY. Empty or absent: NO_PROXY decides. */
  noProxy?: readonly string[];
};

type Protocol = 'http:' | 'https:';

type ProxySource = 'http.proxy' | 'https_proxy' | 'HTTPS_PROXY' | 'http_proxy' | 'HTTP_PROXY';

type ProxyRoute = { kind: 'direct' } | { kind: 'proxy'; url: string } | { kind: 'unusable'; source: ProxySource };

class SalesforceProxyError extends AlvError {
  public constructor(source: ProxySource) {
    super(
      'PROXY_CONFIGURATION',
      `Salesforce requests were not sent because ${source} is not a proxy URL they can use. Set it to a full URL, such as http://proxy.example.com:8080, or remove it.`
    );
    this.name = 'SalesforceProxyError';
  }
}

/** undici reports a request its dispatcher refused as `TypeError: fetch failed`, with the reason as its cause. */
export function unwrapSalesforceProxyError(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof SalesforceProxyError ? cause : error;
}

/**
 * Routes every jsforce request of this process, connection calls and token refreshes alike, through one dispatcher
 * that honors NO_PROXY; jsforce's own per-request proxy agent ignores it. CometD streaming runs on Faye and is not
 * covered. Calling it again replaces the route for the next request. Each protocol keeps its own proxy. When undici
 * rejects a protocol's proxy URL, every request over that protocol, bypass hosts included, fails with a
 * `SalesforceProxyError` and is never sent direct.
 */
export function configureSalesforceProxy(settings: SalesforceProxySettings = {}): void {
  const proxyUrl = settings.proxyUrl?.trim();
  const routes: Record<Protocol, ProxyRoute> = {
    'http:': routeFor('http:', proxyUrl),
    'https:': routeFor('https:', proxyUrl)
  };

  setDefaults({
    timeout: process.env.HTTP_TIMEOUT ? parseInt(process.env.HTTP_TIMEOUT, 10) : undefined,
    followRedirect: true
  });
  setDispatcher(dispatcherFor(routes, settings.noProxy?.length ? settings.noProxy.join(',') : undefined));
}

const VARIABLES: Record<Protocol, readonly ProxySource[]> = {
  'http:': ['http_proxy', 'HTTP_PROXY'],
  'https:': ['https_proxy', 'HTTPS_PROXY']
};

/**
 * Mirrors undici's lookup: the first defined variable wins, lowercase first, so an empty one still hides its uppercase
 * twin; https falls back to the http proxy. The name comes from `Object.keys`, which keeps the spelling the user set:
 * Windows looks variables up in any case, so `process.env.http_proxy` also reads `HTTP_PROXY` there.
 */
function routeFor(protocol: Protocol, proxyUrl: string | undefined): ProxyRoute {
  if (proxyUrl) return checkedRoute('http.proxy', proxyUrl);
  const defined = Object.keys(process.env);
  const source = VARIABLES[protocol].find(name => defined.includes(name));
  const url = source && process.env[source];
  if (source && url) return checkedRoute(source, url);
  return protocol === 'https:' ? routeFor('http:', undefined) : { kind: 'direct' };
}

function checkedRoute(source: ProxySource, url: string): ProxyRoute {
  let probe: ProxyAgent;
  try {
    probe = new ProxyAgent(url);
  } catch {
    return { kind: 'unusable', source };
  }
  probe.close().catch(() => undefined);
  return { kind: 'proxy', url };
}

function dispatcherFor(routes: Record<Protocol, ProxyRoute>, noProxy: string | undefined): Dispatcher {
  const urlOf = (route: ProxyRoute) => (route.kind === 'proxy' ? route.url : '');
  const agent = new EnvHttpProxyAgent({
    allowH2: false,
    httpProxy: urlOf(routes['http:']),
    httpsProxy: urlOf(routes['https:']),
    noProxy
  });
  const refusals = new Map<string, Dispatcher>();
  for (const [protocol, route] of Object.entries(routes)) {
    if (route.kind === 'unusable') refusals.set(protocol, refusingAgent(route.source));
  }
  if (refusals.size === 0) return agent;
  return agent.compose(dispatch => (options, handler) => {
    const refusal = refusals.get(new URL(String(options.origin)).protocol);
    return refusal ? refusal.dispatch(options, handler) : dispatch(options, handler);
  });
}

function refusingAgent(source: ProxySource): Agent {
  return new Agent({ connect: (_options, callback) => callback(new SalesforceProxyError(source), null) });
}

configureSalesforceProxy();
