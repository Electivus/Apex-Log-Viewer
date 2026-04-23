import {
  applyE2eNetworkEnvironment,
  resolveE2eProxyConfig,
  resolveVsCodeProxyLaunchArgs,
  resolveVsCodeUserProxySettings
} from '../proxy';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const PROXY_ENV_NAMES = [
  'ALV_E2E_PROXY_SERVER',
  'ALV_E2E_PROXY_BYPASS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
] as const;

function clearProcessProxyEnv(): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const name of PROXY_ENV_NAMES) {
    previous[name] = process.env[name];
    delete process.env[name];
  }
  return previous;
}

function restoreProcessProxyEnv(previous: Record<string, string | undefined>): void {
  for (const name of PROXY_ENV_NAMES) {
    const value = previous[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

describe('resolveE2eProxyConfig', () => {
  test('normalizes an explicit proxy URL, strips credentials for Chromium, and derives auth headers', () => {
    const config = resolveE2eProxyConfig({
      ALV_E2E_PROXY_SERVER: 'http://username:pwd@proxy.corp.local:8080',
      ALV_E2E_PROXY_BYPASS: 'localhost, 127.0.0.1, .corp.local',
      ALV_E2E_PROXY_STRICT_SSL: '0',
      ALV_E2E_USE_SYSTEM_CA: '1'
    });

    expect(config).toMatchObject({
      proxyUrl: 'http://username:pwd@proxy.corp.local:8080',
      proxyServer: 'http://proxy.corp.local:8080',
      bypass: 'localhost, 127.0.0.1, .corp.local',
      chromiumBypassList: 'localhost;127.0.0.1;.corp.local',
      strictSsl: false,
      strictSslConfigured: true,
      useSystemCa: true,
      hasProxy: true
    });
    expect(config.authorization).toBe('Basic dXNlcm5hbWU6cHdk');
  });

  test('falls back to standard proxy environment variables when no E2E-only override is present', () => {
    const config = resolveE2eProxyConfig({
      HTTPS_PROXY: 'http://proxy.corp.local:3128',
      NO_PROXY: 'localhost,.corp.local'
    });

    expect(config.proxyUrl).toBe('http://proxy.corp.local:3128');
    expect(config.proxyServer).toBe('http://proxy.corp.local:3128');
    expect(config.bypass).toBe('localhost,.corp.local');
    expect(config.hasProxy).toBe(true);
  });

  test('rejects malformed proxy URLs without echoing credentials in the error', () => {
    try {
      resolveE2eProxyConfig({
        HTTPS_PROXY: 'http://username:pwd@'
      });
      throw new Error('Expected malformed proxy URL to be rejected.');
    } catch (error) {
      expect(String(error)).toContain('Invalid proxy URL');
      expect(String(error)).not.toContain('username');
      expect(String(error)).not.toContain('pwd');
    }
  });
});

describe('applyE2eNetworkEnvironment', () => {
  test('maps E2E proxy shorthands onto standard env vars and Node trust settings', () => {
    const env: NodeJS.ProcessEnv = {
      ALV_E2E_PROXY_SERVER: 'http://proxy.corp.local:8080',
      ALV_E2E_PROXY_BYPASS: 'localhost,.corp.local',
      ALV_E2E_USE_SYSTEM_CA: '1',
      NODE_EXTRA_CA_CERTS: '/tmp/corp-ca.pem'
    };

    const config = applyE2eNetworkEnvironment(env);

    expect(config.proxyUrl).toBe('http://proxy.corp.local:8080');
    expect(env.HTTP_PROXY).toBe('http://proxy.corp.local:8080');
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp.local:8080');
    expect(env.http_proxy).toBe('http://proxy.corp.local:8080');
    expect(env.https_proxy).toBe('http://proxy.corp.local:8080');
    expect(env.NO_PROXY).toBe('localhost,.corp.local');
    expect(env.no_proxy).toBe('localhost,.corp.local');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.NODE_USE_SYSTEM_CA).toBe('1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/tmp/corp-ca.pem');
  });

  test('preserves distinct HTTP and HTTPS proxy values when they are already configured conventionally', () => {
    const env: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://proxy-http.corp.local:8080',
      HTTPS_PROXY: 'http://proxy-https.corp.local:8443',
      NO_PROXY: 'localhost,.corp.local'
    };

    applyE2eNetworkEnvironment(env);

    expect(env.HTTP_PROXY).toBe('http://proxy-http.corp.local:8080');
    expect(env.HTTPS_PROXY).toBe('http://proxy-https.corp.local:8443');
    expect(env.http_proxy).toBe('http://proxy-http.corp.local:8080');
    expect(env.https_proxy).toBe('http://proxy-https.corp.local:8443');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  test('restores the previous global fetch dispatcher after process proxy variables are removed', () => {
    const originalEnv = clearProcessProxyEnv();
    const originalDispatcher = getGlobalDispatcher();
    const baselineDispatcher = new Agent();

    try {
      setGlobalDispatcher(baselineDispatcher);
      process.env.HTTP_PROXY = 'http://proxy.corp.local:8080';
      applyE2eNetworkEnvironment();

      const proxiedDispatcher = getGlobalDispatcher();
      expect(proxiedDispatcher).not.toBe(baselineDispatcher);

      delete process.env.HTTP_PROXY;
      delete process.env.http_proxy;
      applyE2eNetworkEnvironment();

      expect(getGlobalDispatcher()).toBe(baselineDispatcher);
    } finally {
      setGlobalDispatcher(originalDispatcher);
      restoreProcessProxyEnv(originalEnv);
    }
  });
});

describe('resolveVsCodeUserProxySettings', () => {
  test('writes a sanitized proxy URL plus explicit auth header for the isolated VS Code profile', () => {
    const settings = resolveVsCodeUserProxySettings({
      HTTPS_PROXY: 'http://username:pwd@proxy.corp.local:8080',
      ALV_E2E_PROXY_STRICT_SSL: '0'
    });

    expect(settings).toEqual({
      'http.proxy': 'http://proxy.corp.local:8080',
      'http.proxyAuthorization': 'Basic dXNlcm5hbWU6cHdk',
      'http.proxyStrictSSL': false
    });
  });
});

describe('resolveVsCodeProxyLaunchArgs', () => {
  test('prefers PAC configuration for the Chromium side of the isolated VS Code launch', () => {
    const args = resolveVsCodeProxyLaunchArgs({
      ALV_E2E_PROXY_SERVER: 'http://proxy.corp.local:8080',
      ALV_E2E_PROXY_PAC_URL: 'http://proxy.corp.local/proxy.pac',
      ALV_E2E_PROXY_BYPASS: 'localhost,127.0.0.1'
    });

    expect(args).toEqual([
      '--proxy-pac-url=http://proxy.corp.local/proxy.pac',
      '--proxy-bypass-list=localhost;127.0.0.1'
    ]);
  });
});
