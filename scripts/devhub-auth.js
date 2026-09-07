'use strict';

const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createPrivateKey } = require('node:crypto');

const JWT_FIELDS = [
  'SF_DEVHUB_CLIENT_ID',
  'SF_DEVHUB_USERNAME',
  'SF_DEVHUB_LOGIN_URL',
  'SF_DEVHUB_PRIVATE_KEY',
  'SF_DEVHUB_PRIVATE_KEY_FILE'
];

function hasDevHubJwtConfig(env = process.env) {
  return JWT_FIELDS.some(name => String(env[name] || '').trim());
}

function isUsableSfdxAuthUrl(value) {
  if (typeof value !== 'string' || /redacted|placeholder|[\s<>*]/i.test(value)) {
    return false;
  }
  return /^force:\/\/[^:@]*:[^:@]*:[^:@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(value);
}

function safeSfFailureMessage(error, fallback = 'Salesforce CLI credential operation failed.') {
  const message = error instanceof Error ? error.message : String(error || '');
  // Never forward CLI output from a credential-bearing operation. Only known,
  // actionable classifications may cross the logging/artifact boundary.
  const diagnostics = [
    ['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED: Check Dev Hub scratch signup limits.'],
    ['C-1016', 'C-1016: Scratch signup must use the PlatformCLI override with this CLI version.'],
    ['NamedOrgNotFoundError', 'NamedOrgNotFoundError: No authorization information found.'],
    ['NoAuthFoundForTargetOrgError', 'NoAuthFoundForTargetOrgError: No authorization information found.'],
    ['INVALID_AUTH', 'Check the selected identity, ECA preauthorization and certificate.'],
    ['invalid_grant', 'Check the selected identity, ECA preauthorization and certificate.'],
    ['CERT_', 'Check the approved corporate CA trust configuration.']
  ];
  const diagnostic = diagnostics.find(([code]) => message.includes(code));
  return diagnostic ? `${fallback} ${diagnostic[1]}` : fallback;
}

function resolveDevHubConfig(env = process.env, { required = true } = {}) {
  if (!required) {
    return undefined;
  }
  const value = name => String(env[name] || '').trim();
  const selectedJwt = hasDevHubJwtConfig(env);
  const ci = /^(1|true)$/i.test(value('CI')) || value('GITHUB_ACTIONS') === 'true';
  if (!selectedJwt) {
    if (ci) {
      throw new Error(
        'CI requires complete Dev Hub JWT configuration: SF_DEVHUB_CLIENT_ID, SF_DEVHUB_USERNAME, SF_DEVHUB_LOGIN_URL and SF_DEVHUB_PRIVATE_KEY or SF_DEVHUB_PRIVATE_KEY_FILE.'
      );
    }
    if (value('SF_DEVHUB_ALIAS')) {
      return { mode: 'alias', alias: value('SF_DEVHUB_ALIAS') };
    }
    throw new Error(
      'Missing required Dev Hub configuration. Set complete JWT inputs or an authenticated SF_DEVHUB_ALIAS locally. SF_DEVHUB_AUTH_URL is no longer supported.'
    );
  }
  const missing = JWT_FIELDS.slice(0, 3).filter(name => !value(name));
  if (!value('SF_DEVHUB_PRIVATE_KEY') && !value('SF_DEVHUB_PRIVATE_KEY_FILE')) {
    missing.push('SF_DEVHUB_PRIVATE_KEY or SF_DEVHUB_PRIVATE_KEY_FILE');
  }
  if (missing.length) {
    throw new Error(
      `Incomplete Dev Hub JWT configuration. Missing: ${missing.join(', ')}. No alias or authorization URL fallback is allowed.`
    );
  }
  if (value('SF_DEVHUB_PRIVATE_KEY') && value('SF_DEVHUB_PRIVATE_KEY_FILE')) {
    throw new Error('Set only one of SF_DEVHUB_PRIVATE_KEY and SF_DEVHUB_PRIVATE_KEY_FILE.');
  }
  return {
    mode: 'jwt',
    clientId: value('SF_DEVHUB_CLIENT_ID'),
    username: value('SF_DEVHUB_USERNAME'),
    loginUrl: value('SF_DEVHUB_LOGIN_URL'),
    privateKey: value('SF_DEVHUB_PRIVATE_KEY') || undefined,
    privateKeyFile: value('SF_DEVHUB_PRIVATE_KEY_FILE') || undefined
  };
}

// Credentials and opt-ins belong only to the child that consumes them. Keep
// proxy and certificate trust inherited from the caller.
function salesforceChildEnv(env = process.env, overrides = {}) {
  const child = { ...env };
  for (const name of [
    ...JWT_FIELDS,
    'SF_DEVHUB_AUTH_URL',
    'SFDX_AUTH_URL',
    'SF_TEMP_SHOW_SECRETS',
    'SF_SCRATCH_SIGNUP_CONNECTED_APP',
    'SF_SCRATCH_SIGNUP_CALLBACK_URL'
  ]) {
    delete child[name];
  }
  return { ...child, ...overrides };
}

function scratchSignupEnv(env = process.env) {
  return salesforceChildEnv(env, {
    SF_SCRATCH_SIGNUP_CONNECTED_APP: 'PlatformCLI',
    SF_SCRATCH_SIGNUP_CALLBACK_URL: 'http://localhost:1717/OauthRedirect'
  });
}

function validateJwt(config, files) {
  if (!/^[A-Za-z0-9._-]+$/.test(config.clientId) || /redacted|placeholder/i.test(config.clientId)) {
    throw new Error('Invalid SF_DEVHUB_CLIENT_ID. Supply the ECA consumer key, not a redaction placeholder.');
  }
  if (!/^[^\s<>]+@[^\s<>]+$/.test(config.username) || /redacted|placeholder/i.test(config.username)) {
    throw new Error('Invalid SF_DEVHUB_USERNAME. Supply the explicitly selected Salesforce username.');
  }
  try {
    const url = new URL(config.loginUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error();
    }
  } catch {
    throw new Error('Invalid SF_DEVHUB_LOGIN_URL. Supply an HTTPS login origin without credentials, query or path.');
  }
  try {
    const key = createPrivateKey(config.privateKey || files.readFileSync(path.resolve(config.privateKeyFile), 'utf8'));
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) {
      throw new Error();
    }
  } catch {
    throw new Error(
      'Invalid SF_DEVHUB_PRIVATE_KEY or SF_DEVHUB_PRIVATE_KEY_FILE. Supply a readable, unencrypted RSA PEM private key (at least 2048 bits).'
    );
  }
}

async function authenticateDevHub(config, runJson, files = fs) {
  if (!config) {
    throw new Error('Missing required Dev Hub authentication configuration.');
  }
  const callerEnv = salesforceChildEnv();
  const deleteWithEnv = async (targetOrg, env) => {
    try {
      const result = await runJson(['org', 'delete', 'scratch', '--target-org', targetOrg, '--no-prompt'], { env });
      if (result?.status !== 0) throw new Error();
    } catch (error) {
      throw new Error(safeSfFailureMessage(error, 'Scratch deletion failed.'));
    }
  };
  if (config.mode === 'alias') {
    try {
      const response = await runJson(['org', 'display', '--target-org', config.alias], { env: callerEnv });
      if (response?.status !== 0) {
        throw new Error('Alias validation did not succeed.');
      }
    } catch {
      throw new Error(
        'SF_DEVHUB_ALIAS is not authenticated or unavailable. Authenticate that alias locally or configure complete Dev Hub JWT inputs.'
      );
    }
    return {
      targetOrg: config.alias,
      env: callerEnv,
      publishScratch: async () => {},
      deleteScratch: target => deleteWithEnv(target, callerEnv),
      cleanup: async () => {}
    };
  }

  validateJwt(config, files);

  const temporaryRoot = path.resolve(tmpdir());
  let directory;
  let env = callerEnv;
  let recoveryScratch;
  const cleanup = async () => {
    if (directory) {
      if (recoveryScratch) {
        throw new Error(
          `Scratch authorization transfer failed for '${recoveryScratch}'. Credential cleanup deferred to preserve access. Recover the scratch from the isolated CLI home, then remove the credential directory: ${directory}`
        );
      }
      try {
        if (
          path.dirname(path.resolve(directory)) !== temporaryRoot ||
          !path.basename(directory).startsWith('alv-devhub-jwt-')
        ) {
          throw new Error('Unexpected credential directory.');
        }
        files.rmSync(directory, { recursive: true, force: true });
      } catch {
        throw new Error(
          `Dev Hub JWT temporary-key cleanup failed (including isolated CLI state). Remove the credential directory: ${directory}`
        );
      }
    }
  };
  try {
    let keyFile = config.privateKeyFile ? path.resolve(config.privateKeyFile) : undefined;
    if (config.privateKey) {
      directory = files.mkdtempSync(path.join(temporaryRoot, 'alv-devhub-jwt-'));
      // Salesforce core resolves .sf/.sfdx through os.homedir() in each child.
      // Keep the parent's environment and preexisting same-username auth intact.
      env = salesforceChildEnv(
        callerEnv,
        process.platform === 'win32' ? { USERPROFILE: directory } : { HOME: directory }
      );
      keyFile = path.join(directory, 'private-key.pem');
      files.writeFileSync(keyFile, config.privateKey, { encoding: 'utf8', mode: 0o600 });
    }
    const response = await runJson(
      [
        'org',
        'login',
        'jwt',
        '--client-id',
        config.clientId,
        '--username',
        config.username,
        '--instance-url',
        config.loginUrl,
        '--jwt-key-file',
        keyFile
      ],
      { env }
    );
    if (response?.status !== 0 || response?.result?.username !== config.username) {
      throw new Error('JWT login did not confirm the selected identity.');
    }
  } catch {
    await cleanup();
    throw new Error(
      'Dev Hub JWT login failed. Check SF_DEVHUB_CLIENT_ID, SF_DEVHUB_USERNAME, SF_DEVHUB_LOGIN_URL, SF_DEVHUB_PRIVATE_KEY or SF_DEVHUB_PRIVATE_KEY_FILE, the certificate and ECA preauthorization. No alias or authorization URL fallback was attempted.'
    );
  }
  const publishedScratchUsers = new Map();
  const transferScratch = async (alias, sourceEnv, destinationEnv, setDefault = false) => {
    // Use supported CLI export/import instead of copying encrypted auth state.
    // Scratch refresh-token auth must outlive the Dev Hub session for keep-org.
    const authFile = path.join(directory, 'scratch.sfdxurl');
    try {
      const exported = await runJson(['org', 'auth', 'show-sfdx-auth-url', '--target-org', alias, '--no-prompt'], {
        env: salesforceChildEnv(sourceEnv, { SF_TEMP_SHOW_SECRETS: 'true' })
      });
      if (exported?.status !== 0 || !isUsableSfdxAuthUrl(exported?.result?.sfdxAuthUrl)) throw new Error();
      files.writeFileSync(authFile, exported.result.sfdxAuthUrl, { encoding: 'utf8', mode: 0o600 });
      const imported = await runJson(
        [
          'org',
          'login',
          'sfdx-url',
          '--sfdx-url-file',
          authFile,
          '--alias',
          alias,
          ...(setDefault ? ['--set-default'] : [])
        ],
        { env: destinationEnv }
      );
      const username = imported?.result?.username;
      if (
        imported?.status !== 0 ||
        typeof username !== 'string' ||
        !username.includes('@') ||
        username === config.username
      )
        throw new Error();
      files.rmSync(authFile, { force: true });
      return username;
    } catch {
      throw new Error(`Scratch authorization transfer failed for '${alias}'.`);
    }
  };
  const publishScratch = async (alias, { setDefault = false } = {}) => {
    if (!directory) return;
    recoveryScratch = alias;
    publishedScratchUsers.set(alias, await transferScratch(alias, env, callerEnv, setDefault));
    recoveryScratch = undefined;
  };
  const deleteScratch = async alias => {
    if (!directory) return deleteWithEnv(alias, callerEnv);
    try {
      let username = publishedScratchUsers.get(alias);
      let hasCallerAuth = Boolean(username);
      if (!username) {
        // A reused scratch lives in the caller's state. A failed signup/import
        // may instead have left its only authorization in this owned home.
        try {
          const display = await runJson(['org', 'display', '--target-org', alias], { env });
          if (display?.status === 0) username = display?.result?.username;
        } catch {
          /* Try the existing caller scratch below. */
        }
        if (!username) {
          username = await transferScratch(alias, callerEnv, env);
          hasCallerAuth = true;
        }
      }
      if (typeof username !== 'string' || !username.includes('@') || username === config.username) throw new Error();
      await deleteWithEnv(username, env);
      if (recoveryScratch === alias) recoveryScratch = undefined;
      // Remote deletion is confirmed first. Target only that scratch username;
      // never log out the Dev Hub or an alias that another run could repoint.
      if (hasCallerAuth) {
        const loggedOut = await runJson(['org', 'logout', '--target-org', username, '--no-prompt'], { env: callerEnv });
        if (loggedOut?.status !== 0) throw new Error();
      }
    } catch {
      throw new Error(
        `Scratch cleanup failed for '${alias}'. Delete this test scratch and its local authorization explicitly.`
      );
    }
  };
  // Token renewal and pool lease release still need the isolated key/auth state.
  return { targetOrg: config.username, env, publishScratch, deleteScratch, cleanup };
}

module.exports = {
  hasDevHubJwtConfig,
  isUsableSfdxAuthUrl,
  safeSfFailureMessage,
  resolveDevHubConfig,
  authenticateDevHub,
  salesforceChildEnv,
  scratchSignupEnv
};
