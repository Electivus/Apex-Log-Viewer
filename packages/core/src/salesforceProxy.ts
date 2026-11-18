// jsforce sets its request defaults when its transport module loads. Loading it first makes ours the ones that stay.
import '@jsforce/jsforce-node/lib/transport';
import { setDefaults, setDispatcher } from '@jsforce/jsforce-node/lib/request';
import { Agent, EnvHttpProxyAgent, Pool, ProxyAgent, type buildConnector, type Dispatcher } from 'undici';

import { AlvError } from './errors.js';

export type SalesforceProxySettings = {
  /** A proxy URL, credentials allowed, for http and https requests. Blank or absent: HTTPS_PROXY and HTTP_PROXY decide. */
  proxyUrl?: string;
  /** Hosts that skip the proxy, in NO_PROXY syntax. Non-empty: replaces NO_PROXY. Empty or absent: NO_PROXY decides. */
  noProxy?: readonly string[];
};

type Protocol = 'http:' | 'https:';

/** `http.proxy`, or a proxy variable as the environment spells it. */
type ProxySource = string;

type ProxyRoute =
  { kind: 'direct' } | { kind: 'proxy'; url: string; source: ProxySource } | { kind: 'unusable'; source: ProxySource };

class SalesforceProxyError extends AlvError {
  public constructor(code: 'PROXY_CONFIGURATION' | 'PROXY_CONNECTION', message: string) {
    super(code, message);
    this.name = 'SalesforceProxyError';
  }
}

const unusableProxy = (source: ProxySource) =>
  new SalesforceProxyError(
    'PROXY_CONFIGURATION',
    `Salesforce requests were not sent because ${source} is not a proxy URL they can use. Set it to a full URL, such as http://proxy.example.com:8080, or remove it.`
  );

/**
 * jsforce retries a refused connection until HTTP_TIMEOUT aborts it and then reports a 30-minute timeout. This code is
 * not one it retries, so the request fails at once and says which proxy to check.
 */
const unreachableProxy = (source: ProxySource, error: Error) =>
  new SalesforceProxyError(
    'PROXY_CONNECTION',
    `Salesforce requests could not connect to the proxy that ${source} names (${(error as NodeJS.ErrnoException).code ?? error.message}). Check that the proxy is running at that address, or change or remove ${source}.`
  );

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
 * `SalesforceProxyError` and is never sent direct. A request that cannot connect to its http or https proxy fails at once
 * with a `SalesforceProxyError` naming that proxy's source.
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

const VARIABLES: Record<Protocol, readonly string[]> = {
  'http:': ['http_proxy', 'HTTP_PROXY'],
  'https:': ['https_proxy', 'HTTPS_PROXY']
};

/**
 * Mirrors undici's lookup: the first defined variable wins, lowercase first, so an empty one still hides its uppercase
 * twin; https falls back to the http proxy.
 */
function routeFor(protocol: Protocol, proxyUrl: string | undefined): ProxyRoute {
  if (proxyUrl) return checkedRoute('http.proxy', proxyUrl);
  const source = VARIABLES[protocol].map(definedVariable).find(name => name !== undefined);
  const url = source && process.env[source];
  if (source && url) return checkedRoute(source, url);
  return protocol === 'https:' ? routeFor('http:', undefined) : { kind: 'direct' };
}

/**
 * Windows matches variable names in any case, so `Https_Proxy` is `HTTPS_PROXY` there. `Object.keys` keeps the spelling
 * that was set, for the error to name.
 */
function definedVariable(name: string): string | undefined {
  const names = Object.keys(process.env);
  if (process.platform !== 'win32') return names.includes(name) ? name : undefined;
  return names.find(key => key.toUpperCase() === name.toUpperCase());
}

/** The schemes the docs name. The locked undici refuses every other one itself; this pins the set against a later one. */
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks5:']);

/**
 * A usable proxy URL has one of those schemes, a host, and no port 0. undici's `ProxyAgent` alone is not the rule: for
 * SOCKS it accepts a URL with no host and dials localhost, and it turns port 0 into 1080. It ignores a SOCKS URL's path,
 * query and fragment, and refuses a path on an http or https proxy URL by itself.
 */
function isProxyUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return PROXY_SCHEMES.has(url.protocol) && url.hostname !== '' && url.port !== '0';
}

function checkedRoute(source: ProxySource, url: string): ProxyRoute {
  if (!isProxyUrl(url)) return { kind: 'unusable', source };
  let probe: ProxyAgent;
  try {
    probe = new ProxyAgent(url);
  } catch {
    return { kind: 'unusable', source };
  }
  probe.close().catch(() => undefined);
  return { kind: 'proxy', url, source };
}

function dispatcherFor(routes: Record<Protocol, ProxyRoute>, noProxy: string | undefined): Dispatcher {
  const http = protocolDispatcher('http:', routes['http:'], noProxy);
  const https = protocolDispatcher('https:', routes['https:'], noProxy);
  return https.compose(
    dispatch => (options, handler) =>
      new URL(String(options.origin)).protocol === 'https:'
        ? dispatch(options, handler)
        : http.dispatch(options, handler)
  );
}

function protocolDispatcher(protocol: Protocol, route: ProxyRoute, noProxy: string | undefined): Dispatcher {
  if (route.kind === 'unusable') {
    return new Agent({ connect: (_options, callback) => callback(unusableProxy(route.source), null) });
  }
  const url = route.kind === 'proxy' ? route.url : '';
  const options: EnvHttpProxyAgent.Options & Pick<ProxyAgent.Options, 'clientFactory'> = {
    allowH2: false,
    httpProxy: protocol === 'http:' ? url : '',
    httpsProxy: protocol === 'https:' ? url : '',
    noProxy,
    // The proxy client: the connection to the proxy that carries each CONNECT tunnel. SOCKS dials on its own.
    clientFactory: (origin, clientOptions) => {
      const { connect } = clientOptions as { connect: buildConnector.connector };
      return new Pool(origin, { ...clientOptions, connect: reportingConnector(connect, route) });
    }
  };
  return new EnvHttpProxyAgent(options);
}

function reportingConnector(connect: buildConnector.connector, route: ProxyRoute): buildConnector.connector {
  if (route.kind !== 'proxy') return connect;
  return (options, callback) =>
    connect(options, (...result) =>
      result[0] === null ? callback(...result) : callback(unreachableProxy(route.source, result[0]), null)
    );
}

configureSalesforceProxy();
