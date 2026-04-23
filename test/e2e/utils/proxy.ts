import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

let appliedFetchProxyKey: string | undefined;

export type E2eProxyConfig = {
  proxyUrl?: string;
  proxyServer?: string;
  bypass?: string;
  chromiumBypassList?: string;
  pacUrl?: string;
  authorization?: string;
  strictSsl: boolean;
  strictSslConfigured: boolean;
  useSystemCa: boolean;
  extraCaCerts?: string;
  hasProxy: boolean;
};

function readEnvValue(names: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of names) {
    const value = String(env[name] || '').trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readBooleanEnv(
  names: string[],
  defaultValue: boolean,
  env: NodeJS.ProcessEnv = process.env
): { value: boolean; configured: boolean } {
  const raw = readEnvValue(names, env);
  if (raw === undefined) {
    return {
      value: defaultValue,
      configured: false
    };
  }

  const normalized = raw.toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return { value: true, configured: true };
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return { value: false, configured: true };
  }

  return {
    value: defaultValue,
    configured: true
  };
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function trimProxyUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function normalizeProxyUrl(rawValue: string): { proxyUrl: string; proxyServer: string; authorization?: string } {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) {
    throw new Error('Proxy URL cannot be empty.');
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      proxyUrl: trimmed,
      proxyServer: trimmed
    };
  }

  const username = decodeUserInfo(parsed.username);
  const password = decodeUserInfo(parsed.password);
  const authorization =
    username || password ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` : undefined;

  const proxyUrl = trimProxyUrl(parsed.toString());
  parsed.username = '';
  parsed.password = '';

  return {
    proxyUrl,
    proxyServer: trimProxyUrl(parsed.toString()),
    authorization
  };
}

function normalizeChromiumBypassList(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value
    .split(/[;,]/)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(';') : undefined;
}

export function resolveE2eProxyConfig(env: NodeJS.ProcessEnv = process.env): E2eProxyConfig {
  const proxyValue = readEnvValue(
    ['ALV_E2E_PROXY_SERVER', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
    env
  );
  const bypass = readEnvValue(['ALV_E2E_PROXY_BYPASS', 'NO_PROXY', 'no_proxy'], env);
  const pacUrl = readEnvValue(['ALV_E2E_PROXY_PAC_URL'], env);
  const strictSsl = readBooleanEnv(['ALV_E2E_PROXY_STRICT_SSL'], true, env);
  const useSystemCa = readBooleanEnv(['ALV_E2E_USE_SYSTEM_CA', 'NODE_USE_SYSTEM_CA'], false, env);

  const normalizedProxy = proxyValue ? normalizeProxyUrl(proxyValue) : undefined;
  const explicitAuthorization = readEnvValue(['ALV_E2E_PROXY_AUTHORIZATION'], env);

  return {
    proxyUrl: normalizedProxy?.proxyUrl,
    proxyServer: normalizedProxy?.proxyServer,
    bypass,
    chromiumBypassList: normalizeChromiumBypassList(bypass),
    pacUrl,
    authorization: explicitAuthorization || normalizedProxy?.authorization,
    strictSsl: strictSsl.value,
    strictSslConfigured: strictSsl.configured,
    useSystemCa: useSystemCa.value,
    extraCaCerts: readEnvValue(['NODE_EXTRA_CA_CERTS'], env),
    hasProxy: Boolean(normalizedProxy?.proxyUrl || pacUrl)
  };
}

export function applyE2eNetworkEnvironment(env: NodeJS.ProcessEnv = process.env): E2eProxyConfig {
  const config = resolveE2eProxyConfig(env);
  const explicitProxyOverride = readEnvValue(['ALV_E2E_PROXY_SERVER'], env);
  const explicitBypassOverride = readEnvValue(['ALV_E2E_PROXY_BYPASS'], env);

  if (explicitProxyOverride) {
    const normalized = normalizeProxyUrl(explicitProxyOverride).proxyUrl;
    env.HTTPS_PROXY = normalized;
    env.HTTP_PROXY = normalized;
    env.https_proxy = normalized;
    env.http_proxy = normalized;
  } else {
    const httpsProxy = readEnvValue(['HTTPS_PROXY', 'https_proxy'], env);
    const httpProxy = readEnvValue(['HTTP_PROXY', 'http_proxy'], env);
    if (httpsProxy) {
      env.HTTPS_PROXY = env.HTTPS_PROXY || httpsProxy;
      env.https_proxy = env.https_proxy || httpsProxy;
    }
    if (httpProxy) {
      env.HTTP_PROXY = env.HTTP_PROXY || httpProxy;
      env.http_proxy = env.http_proxy || httpProxy;
    }
  }

  if (config.proxyUrl) {
    env.NODE_USE_ENV_PROXY = env.NODE_USE_ENV_PROXY || '1';
  }

  if (explicitBypassOverride) {
    env.NO_PROXY = explicitBypassOverride;
    env.no_proxy = explicitBypassOverride;
  } else if (config.bypass) {
    env.NO_PROXY = env.NO_PROXY || config.bypass;
    env.no_proxy = env.no_proxy || config.bypass;
  }

  if (config.useSystemCa) {
    env.NODE_USE_SYSTEM_CA = env.NODE_USE_SYSTEM_CA || '1';
  }

  if (config.extraCaCerts) {
    env.NODE_EXTRA_CA_CERTS = config.extraCaCerts;
  }

  if (env === process.env) {
    applyGlobalFetchProxyDispatcher(env);
  }

  return config;
}

function applyGlobalFetchProxyDispatcher(env: NodeJS.ProcessEnv): void {
  const httpProxy = readEnvValue(['HTTP_PROXY', 'http_proxy'], env);
  const httpsProxy = readEnvValue(['HTTPS_PROXY', 'https_proxy'], env);
  if (!httpProxy && !httpsProxy) {
    return;
  }

  const noProxy = readEnvValue(['NO_PROXY', 'no_proxy'], env);
  const key = JSON.stringify({ httpProxy, httpsProxy, noProxy });
  if (appliedFetchProxyKey === key) {
    return;
  }

  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy
    })
  );
  appliedFetchProxyKey = key;
}

export function resolveVsCodeUserProxySettings(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const config = resolveE2eProxyConfig(env);
  const settings: Record<string, unknown> = {};

  if (config.proxyServer) {
    settings['http.proxy'] = config.proxyServer;
  }
  if (config.authorization) {
    settings['http.proxyAuthorization'] = config.authorization;
  }
  if (config.strictSslConfigured || (!config.strictSsl && config.hasProxy)) {
    settings['http.proxyStrictSSL'] = config.strictSsl;
  }

  return settings;
}

export function resolveVsCodeProxyLaunchArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = resolveE2eProxyConfig(env);
  const args: string[] = [];

  if (config.pacUrl) {
    args.push(`--proxy-pac-url=${config.pacUrl}`);
  } else if (config.proxyServer) {
    args.push(`--proxy-server=${config.proxyServer}`);
  }

  if (config.chromiumBypassList) {
    args.push(`--proxy-bypass-list=${config.chromiumBypassList}`);
  }

  return args;
}
