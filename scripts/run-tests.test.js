const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadDirToExecutablePath } = require('@vscode/test-electron/out/util');
const { ensureDevHub, pretestSetup, resolveMissingExtensionIds, resolveRequiredDevHubConfig } = require('./run-tests');

const originalEnv = { ...process.env };
const testPrivateKey = require('node:crypto').generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
}).privateKey;

test('JWT runner authenticates the selected identity when the CLI colors JSON tokens', async () => {
  const session = await ensureDevHub('sf', {
    mode: 'jwt', clientId: 'test-client', username: 'selected@example.com',
    loginUrl: 'https://login.salesforce.com', privateKey: testPrivateKey
  }, { execFileAsync: async () => ({
    stdout: '{\u001b[34m"status"\u001b[39m:0,"result":{"username":"selected@example.com"}}'
  }) });
  try {
    assert.equal(session.targetOrg, 'selected@example.com');
  } finally {
    await session.cleanup();
  }
});

test('JWT response diagnostics identify a wrong envelope without exposing identity or credentials', async () => {
  await assert.rejects(ensureDevHub('sf', {
    mode: 'jwt', clientId: 'test-client', username: 'selected@example.com',
    loginUrl: 'https://login.salesforce.com', privateKey: testPrivateKey
  }, { execFileAsync: async () => ({ stdout: JSON.stringify({ status: 0,
    username: 'selected@example.com', accessToken: 'private-response-token' }) }) }), error => {
    assert.match(error.message, /status=0.*resultIdentity=false.*topLevelIdentity=true/);
    assert.doesNotMatch(error.message, /selected@example.com|private-response-token|PRIVATE KEY/);
    return true;
  });
});

for (const cli of ['sf', 'sfdx']) {
  test(`concurrent inline ${cli} workflows isolate same-username CLI state and keep scratch access after cleanup`, async t => {
    const homeName = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const callerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-caller-state-'));
    process.env = { ...originalEnv, [homeName]: callerHome, HTTPS_PROXY: 'https://proxy.example.com' };
    t.after(() => {
      process.env = { ...originalEnv };
      fs.rmSync(callerHome, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(callerHome, '.sfdx'));
    const existingState = path.join(callerHome, '.sfdx', 'selected@example.com.json');
    fs.writeFileSync(existingState, 'existing-user-owned-auth');
    const config = {
      mode: 'jwt',
      clientId: 'test-client',
      username: 'selected@example.com',
      loginUrl: 'https://login.salesforce.com',
      privateKey: testPrivateKey
    };
    const sessions = [];
    const deletedScratchUsers = new Set();
    t.after(async () => {
      for (const session of sessions) await session.cleanup();
    });
    const execFileAsync = async (file, args, options) => {
      const home = options.env[homeName];
      assert.equal(options.env.HTTPS_PROXY, process.env.HTTPS_PROXY);
      if (args[1] === 'delete' || args[0] === 'force:org:delete') {
        const username = args[args.indexOf(cli === 'sf' ? '--target-org' : '-u') + 1];
        assert.notEqual(home, callerHome);
        assert.equal(fs.existsSync(path.join(home, 'private-key.pem')), true);
        assert.notEqual(username, config.username);
        deletedScratchUsers.add(username);
        return { stdout: '{"status":0,"result":{}}' };
      }
      if (args[1] === 'logout' || args[0] === 'force:auth:logout') {
        const username = args[args.indexOf(cli === 'sf' ? '--target-org' : '-u') + 1];
        assert.equal(home, callerHome);
        assert.equal(deletedScratchUsers.has(username), true);
        fs.rmSync(path.join(home, '.sfdx', username));
        return { stdout: '{"status":0,"result":{}}' };
      }
      if (args.slice(0, 3).join(' ') === 'org login jwt' || args[0] === 'force:auth:jwt:grant') {
        assert.notEqual(home, callerHome);
        fs.mkdirSync(path.join(home, '.sfdx'));
        fs.writeFileSync(
          path.join(home, '.sfdx', 'selected@example.com.json'),
          args[args.indexOf(cli === 'sf' ? '--jwt-key-file' : '--jwtkeyfile') + 1]
        );
        return { stdout: JSON.stringify({ status: 0, result: { username: config.username } }) };
      }
      if (args.includes('show-sfdx-auth-url') || args[0] === 'force:org:display') {
        if (cli === 'sfdx') assert.equal(args.includes('--verbose'), true);
        assert.notEqual(home, callerHome);
        assert.equal(options.env.SF_TEMP_SHOW_SECRETS, 'true');
        return {
          stdout: JSON.stringify({
            status: 0,
            result: { sfdxAuthUrl: 'force://PlatformCLI::fixture-refresh@test.example.com' }
          })
        };
      }
      if (args.includes('sfdx-url') || args[0] === 'force:auth:sfdxurl:store') {
        assert.equal(home, callerHome);
        assert.equal(options.env.SF_TEMP_SHOW_SECRETS, undefined);
        const alias = args[args.indexOf(cli === 'sf' ? '--alias' : '-a') + 1];
        const username = `${alias}@example.com`;
        fs.writeFileSync(
          path.join(home, '.sfdx', username),
          fs.readFileSync(args[args.indexOf(cli === 'sf' ? '--sfdx-url-file' : '-f') + 1])
        );
        return { stdout: JSON.stringify({ status: 0, result: { username } }) };
      }
      throw new Error('Unexpected CLI operation');
    };
    sessions.push(
      ...(await Promise.all([
        ensureDevHub(cli, config, { execFileAsync }),
        ensureDevHub(cli, config, { execFileAsync })
      ]))
    );
    assert.notEqual(sessions[0].env[homeName], sessions[1].env[homeName]);
    await Promise.all(sessions.map((session, index) => session.publishScratch(`kept-${index}`)));
    await sessions[0].deleteScratch('kept-0');
    await sessions[0].cleanup();
    assert.equal(fs.existsSync(sessions[0].env[homeName]), false);
    assert.equal(fs.existsSync(sessions[1].env[homeName]), true);
    await sessions[1].cleanup();
    assert.equal(fs.existsSync(sessions[1].env[homeName]), false);
    assert.equal(fs.readFileSync(existingState, 'utf8') === 'existing-user-owned-auth', true);
    assert.equal(fs.existsSync(path.join(callerHome, '.sfdx', 'kept-0@example.com')), false);
    assert.equal(fs.existsSync(path.join(callerHome, '.sfdx', 'kept-1@example.com')), true);
    assert.equal(process.env[homeName], callerHome);
  });
}

test('failed scratch auth transfer reports retained recovery state without exposing CLI output', async t => {
  const session = await ensureDevHub(
    'sf',
    {
      mode: 'jwt',
      clientId: 'test-client',
      username: 'selected@example.com',
      loginUrl: 'https://login.salesforce.com',
      privateKey: testPrivateKey
    },
    {
      execFileAsync: async (_file, args) => {
        if (args.includes('jwt')) return { stdout: '{"status":0,"result":{"username":"selected@example.com"}}' };
        throw new Error('untrusted-private-credential');
      }
    }
  );
  const directory = session.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => session.publishScratch('KeptScratch'), /Scratch authorization transfer failed/);
  await assert.rejects(
    () => session.cleanup(),
    error => {
      assert.match(error.message, /cleanup deferred to preserve access/);
      assert.equal(error.message.includes(directory), true);
      assert.doesNotMatch(error.stack, /untrusted-private-credential/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(directory, 'private-key.pem')), true);
});

test('selected JWT authenticates the configured username and keeps its key until workflow cleanup', async t => {
  process.env = {
    ...originalEnv,
    CI: 'true',
    SF_DEVHUB_CLIENT_ID: 'test-eca-client',
    SF_DEVHUB_USERNAME: 'selected@example.com',
    SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
    SF_DEVHUB_PRIVATE_KEY: testPrivateKey,
    SF_DEVHUB_ALIAS: 'UnrelatedCachedAlias'
  };
  t.after(() => {
    process.env = { ...originalEnv };
  });
  let keyFile;
  const session = await ensureDevHub('sf', resolveRequiredDevHubConfig({ requireConfig: true }), {
    execFileAsync: async (file, args, options) => {
      assert.deepEqual(args.slice(0, 3), ['org', 'login', 'jwt']);
      assert.equal(args[args.indexOf('--username') + 1], 'selected@example.com');
      assert.equal(args.includes('UnrelatedCachedAlias'), false);
      keyFile = args[args.indexOf('--jwt-key-file') + 1];
      assert.equal(fs.readFileSync(keyFile, 'utf8'), testPrivateKey.trim());
      assert.equal(options.env.SF_DEVHUB_PRIVATE_KEY, undefined);
      assert.equal(options.env.SF_TEMP_SHOW_SECRETS, undefined);
      return { stdout: '{"status":0,"result":{"username":"selected@example.com"}}' };
    }
  });
  t.after(() => session.cleanup());
  assert.equal(session.targetOrg, 'selected@example.com');
  assert.equal(fs.existsSync(keyFile), true);
  await session.cleanup();
  assert.equal(fs.existsSync(keyFile), false);
});

test('real-org CI rejects a cached alias and legacy URL before scratch mutations', async t => {
  process.env = {
    ...originalEnv,
    CI: 'true',
    SF_SETUP_SCRATCH: '1',
    SF_DEVHUB_ALIAS: 'CachedDevHub',
    SF_DEVHUB_AUTH_URL: 'force://legacy-secret'
  };
  t.after(() => {
    process.env = { ...originalEnv };
  });
  let scratchMutated = false;
  await assert.rejects(
    () =>
      pretestSetup(
        'integration',
        {},
        {
          ensureSfCliInstalled: async () => 'sf',
          ensureDevHub: async () => 'CachedDevHub',
          ensureDefaultScratch: async () => {
            scratchMutated = true;
            return { cleanup: async () => {} };
          }
        }
      ),
    /CI requires.*JWT/
  );
  assert.equal(scratchMutated, false);
});

test('selected malformed JWT is rejected before CLI execution without exposing its contents', async t => {
  process.env = {
    ...originalEnv,
    SF_DEVHUB_CLIENT_ID: 'test-client',
    SF_DEVHUB_USERNAME: 'selected@example.com',
    SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
    SF_DEVHUB_PRIVATE_KEY: 'malformed-private-key-secret',
    SF_DEVHUB_ALIAS: 'CachedDevHub'
  };
  t.after(() => {
    process.env = { ...originalEnv };
  });
  let executed = false;
  await assert.rejects(
    () =>
      ensureDevHub('sf', resolveRequiredDevHubConfig({ requireConfig: true }), {
        execFileAsync: async () => {
          executed = true;
          return { stdout: '{"status":0,"result":{"username":"selected@example.com"}}' };
        }
      }),
    error => {
      assert.match(error.message, /SF_DEVHUB_PRIVATE_KEY/);
      assert.doesNotMatch(error.message, /malformed-private-key-secret/);
      return true;
    }
  );
  assert.equal(executed, false);
});

test('direct setup uses JWT and PlatformCLI children and cleans up after a scratch creation failure', async t => {
  process.env = {
    ...originalEnv,
    CI: 'true',
    SF_DEVHUB_CLIENT_ID: 'test-client',
    SF_DEVHUB_USERNAME: 'selected@example.com',
    SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
    SF_DEVHUB_PRIVATE_KEY: testPrivateKey,
    SF_TEMP_SHOW_SECRETS: 'true',
    SF_SCRATCH_SIGNUP_CONNECTED_APP: 'WrongApp',
    SF_SCRATCH_ALIAS: 'NewScratch'
  };
  t.after(() => {
    process.env = { ...originalEnv };
  });
  let keyFile;
  let created = false;
  await assert.rejects(
    () =>
      pretestSetup(
        'integration',
        {},
        {
          ensureSfCliInstalled: async () => 'sf',
          execFileAsync: async (file, args, options) => {
            assert.equal(options?.env?.SF_DEVHUB_PRIVATE_KEY, undefined);
            assert.equal(options?.env?.SF_TEMP_SHOW_SECRETS, undefined);
            if (args.slice(0, 3).join(' ') === 'org login jwt') {
              keyFile = args[args.indexOf('--jwt-key-file') + 1];
              assert.equal(options?.env?.SF_SCRATCH_SIGNUP_CONNECTED_APP, undefined);
              return { stdout: '{"status":0,"result":{"username":"selected@example.com"}}' };
            }
            if (args.slice(0, 2).join(' ') === 'org display') {
              throw new Error('Scratch alias does not exist');
            }
            if (args.slice(0, 3).join(' ') === 'org create scratch') {
              created = true;
              assert.equal(options?.env?.SF_SCRATCH_SIGNUP_CONNECTED_APP, 'PlatformCLI');
              assert.equal(options?.env?.SF_SCRATCH_SIGNUP_CALLBACK_URL, 'http://localhost:1717/OauthRedirect');
              throw new Error('Scratch signup failed');
            }
            throw new Error('Unexpected command');
          }
        }
      ),
    /Scratch signup failed/
  );
  assert.equal(created, true);
  assert.equal(fs.existsSync(keyFile), false);
  assert.equal(process.env.SF_SCRATCH_SIGNUP_CONNECTED_APP, 'WrongApp');
});

for (const ci of ['true', 'false']) {
  test(`partial JWT fails before execution with CI=${ci}, even with an explicit local alias`, async t => {
    process.env = {
      ...originalEnv,
      CI: ci,
      SF_SETUP_SCRATCH: '1',
      SF_DEVHUB_CLIENT_ID: 'test-client',
      SF_DEVHUB_ALIAS: 'CachedDevHub'
    };
    t.after(() => {
      process.env = { ...originalEnv };
    });
    let executed = false;
    await assert.rejects(
      () =>
        pretestSetup(
          'integration',
          {},
          {
            ensureSfCliInstalled: async () => {
              executed = true;
              return 'sf';
            }
          }
        ),
      /Incomplete Dev Hub JWT configuration.*SF_DEVHUB_USERNAME.*SF_DEVHUB_LOGIN_URL.*SF_DEVHUB_PRIVATE_KEY/
    );
    assert.equal(executed, false);
  });
}

for (const outcome of ['rejected', 'status-error', 'wrong-identity']) {
  test(`selected JWT ${outcome} fails without fallback, credential output or leftover key`, async t => {
    const config = {
      mode: 'jwt',
      clientId: 'test-client',
      username: 'selected@example.com',
      loginUrl: 'https://login.salesforce.com',
      privateKey: testPrivateKey
    };
    let keyFile;
    let calls = 0;
    t.after(() => {
      if (keyFile) fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
    });
    await assert.rejects(
      () =>
        ensureDevHub('sf', config, {
          execFileAsync: async (file, args) => {
            calls++;
            keyFile = args[args.indexOf('--jwt-key-file') + 1];
            if (outcome === 'rejected') throw new Error(`force://sensitive-url consumer-secret ${testPrivateKey}`);
            return {
              stdout: JSON.stringify({
                status: outcome === 'status-error' ? 1 : 0,
                result: { username: 'unrelated@example.com' }
              })
            };
          }
        }),
      error => {
        assert.match(error.message, /Dev Hub JWT login failed.*ECA preauthorization/);
        assert.doesNotMatch(error.stack, /sensitive-url|consumer-secret|BEGIN PRIVATE KEY/);
        return true;
      }
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(keyFile), false);
  });
}

test('JWT key cleanup failure identifies the remaining directory without credential details', async t => {
  let keyFile;
  t.after(() => {
    if (keyFile) fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
  });
  const config = {
    mode: 'jwt',
    clientId: 'test-client',
    username: 'selected@example.com',
    loginUrl: 'https://login.salesforce.com',
    privateKey: testPrivateKey
  };
  await assert.rejects(
    () =>
      ensureDevHub('sf', config, {
        execFileAsync: async (file, args) => {
          keyFile = args[args.indexOf('--jwt-key-file') + 1];
          throw new Error('untrusted-consumer-secret');
        },
        fs: {
          ...fs,
          rmSync: () => {
            throw new Error('untrusted-file-error');
          }
        }
      }),
    error => {
      assert.match(error.message, /temporary-key cleanup failed/);
      assert.equal(error.message.includes(path.dirname(keyFile)), true);
      assert.doesNotMatch(error.stack, /untrusted|BEGIN PRIVATE KEY/);
      return true;
    }
  );
});

test('caller-owned key files survive successful JWT workflow cleanup', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-jwt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'caller.pem');
  fs.writeFileSync(keyFile, testPrivateKey);
  const config = {
    mode: 'jwt',
    clientId: 'test-client',
    username: 'selected@example.com',
    loginUrl: 'https://login.salesforce.com',
    privateKeyFile: keyFile
  };
  const session = await ensureDevHub('sf', config, {
    execFileAsync: async (file, args) => {
      assert.equal(args[args.indexOf('--jwt-key-file') + 1], keyFile);
      return { stdout: '{"status":0,"result":{"username":"selected@example.com"}}' };
    }
  });
  await session.cleanup();
  assert.equal(fs.existsSync(keyFile), true);
});

test(
  'direct authentication honors the configured Windows CLI path with spaces',
  { skip: process.platform !== 'win32' },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alv sf adapter '));
    t.after(() => {
      process.env = { ...originalEnv };
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const capture = path.join(directory, 'args.json');
    const entry = path.join(directory, 'cli.cjs');
    const binary = path.join(directory, 'sf.cmd');
    fs.writeFileSync(
      entry,
      `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({status:0,result:{}}));`
    );
    fs.writeFileSync(binary, `@"${process.execPath}" "${entry}" %*\r\n`);
    process.env.SF_CLI_BIN_PATH = binary;
    delete process.env.ALV_SF_BIN_PATH;
    const session = await ensureDevHub('sf', { mode: 'alias', alias: 'Selected DevHub & literal' });
    await session.cleanup();
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [
      'org',
      'display',
      '--target-org',
      'Selected DevHub & literal',
      '--json'
    ]);
  }
);

test(
  'runner entry point cleans JWT and scratch when VS Code bootstrap fails',
  { skip: process.platform !== 'win32' },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-runner-failure-'));
    const capture = path.join(directory, 'key-path.json');
    const deleted = path.join(directory, 'scratch-deleted.json');
    t.after(() => {
      if (fs.existsSync(capture)) {
        const keyFile = JSON.parse(fs.readFileSync(capture, 'utf8'));
        if (path.basename(path.dirname(keyFile)).startsWith('alv-devhub-jwt-'))
          fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const entry = path.join(directory, 'sf.cjs');
    const binary = path.join(directory, 'sf.cmd');
    fs.writeFileSync(
      entry,
      `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('@salesforce/cli/2.150.6'); process.exit(0); }
    if (args.slice(0,3).join(' ') === 'org login jwt') fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args[args.indexOf('--jwt-key-file') + 1]));
    if (args.slice(0,3).join(' ') === 'org delete scratch') fs.writeFileSync(${JSON.stringify(deleted)}, 'true');
    console.log(JSON.stringify({status:args[1] === 'display' ? 1 : 0, result:{username:args[2] === 'sfdx-url' ? 'scratch@example.com' : 'selected@example.com',sfdxAuthUrl:'force://PlatformCLI::fixture-refresh@test.example.com'}}));
    process.exit(args[1] === 'display' ? 1 : 0);
  `
    );
    fs.writeFileSync(binary, `@"${process.execPath}" "${entry}" %*\r\n`);
    const preload = path.join(directory, 'vscode-failure.cjs');
    fs.writeFileSync(
      preload,
      `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name) {
      if (name === '@vscode/test-electron') return {downloadAndUnzipVSCode: async () => { throw new Error('fixture VS Code bootstrap failure'); }};
      return load.apply(this, arguments);
    };
  `
    );
    const result = require('node:child_process').spawnSync(
      process.execPath,
      ['--require', preload, path.join(__dirname, 'run-tests.js'), '--scope=integration'],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...originalEnv,
          CI: 'true',
          SF_SETUP_SCRATCH: '1',
          SF_CLI_BIN_PATH: binary,
          ALV_SF_BIN_PATH: binary,
          SF_DEVHUB_CLIENT_ID: 'test-client',
          SF_DEVHUB_USERNAME: 'selected@example.com',
          SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
          SF_DEVHUB_PRIVATE_KEY: testPrivateKey,
          SF_TEST_KEEP_ORG: '0'
        },
        encoding: 'utf8',
        timeout: 120_000
      }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture VS Code bootstrap failure/);
    assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(capture, 'utf8'))), false);
    assert.equal(fs.existsSync(deleted), true);
  }
);

test(
  'runner installs dependency extensions through a Windows cmd path with spaces',
  { skip: process.platform !== 'win32' },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alv code shim '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const installed = path.join(directory, 'installed.json');
    const entry = path.join(directory, 'code.cjs');
    const binary = path.join(directory, 'code.cmd');
    fs.writeFileSync(
      entry,
      `
    const fs = require('node:fs');
    if (process.argv.includes('--install-extension')) fs.writeFileSync(${JSON.stringify(installed)}, 'true');
    if (process.argv.includes('--list-extensions') && fs.existsSync(${JSON.stringify(installed)})) console.log('fixture.dependency@1.0.0');
  `
    );
    fs.writeFileSync(binary, `@"${process.execPath}" "${entry}" %*\r\n`);
    const preload = path.join(directory, 'preload.cjs');
    fs.writeFileSync(
      preload,
      `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function(name) {
      if (name === '@vscode/test-electron') return {
        downloadAndUnzipVSCode: async () => 'fixture',
        resolveCliArgsFromVSCodeExecutablePath: () => [${JSON.stringify(binary)}]
      };
      if (name === 'esbuild') return {build: async () => {throw new Error('fixture reached test build');}};
      return load.apply(this, arguments);
    };
  `
    );
    const result = require('node:child_process').spawnSync(
      process.execPath,
      ['--require', preload, path.join(__dirname, 'run-tests.js'), '--scope=unit', '--install-deps'],
      { env: { ...originalEnv, VSCODE_TEST_EXTENSIONS: 'fixture.dependency' }, encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture reached test build/);
    assert.equal(fs.existsSync(installed), true);
  }
);

test('xvfb re-exec preserves original CLI flags', () => {
  const script = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8');

  assert.match(
    script,
    /spawn\(\s*'xvfb-run',\s*\[[\s\S]*process\.execPath,\s*__filename,\s*\.\.\.process\.argv\.slice\(2\)/
  );
});

test('VS Code host runner targets the extension app output paths', () => {
  const script = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8');

  assert.match(script, /extensionDevelopmentPath\s*=\s*resolve\(__dirname,\s*'\.\.',\s*'apps',\s*'vscode-extension'\)/);
  assert.match(
    script,
    /extensionTestsPath\s*=\s*resolve\(__dirname,\s*'\.\.',\s*'apps',\s*'vscode-extension',\s*'out',\s*'test',\s*'runner\.js'\)/
  );
  assert.match(script, /mkdirSync\(dirname\(outfile\),\s*\{\s*recursive:\s*true\s*\}\)/);
});

test('VS Code host runner resolves the executable declared by modern macOS bundles', t => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-vscode-darwin-'));
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));

  const contentsDir = path.join(installDir, 'Visual Studio Code.app', 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.writeFileSync(
    path.join(contentsDir, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleExecutable</key>',
      '  <string>CodeUX</string>',
      '</dict>',
      '</plist>'
    ].join('\n')
  );
  fs.writeFileSync(path.join(macosDir, 'CodeUX'), '');

  assert.equal(downloadDirToExecutablePath(installDir, 'darwin-arm64'), path.join(macosDir, 'CodeUX'));
});

test('VSIX smoke packaging delegates to the monorepo vsce helper', () => {
  const script = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8');

  assert.match(script, /scripts',\s*'run-vsce\.js'/);
  assert.match(script, /'--no-dependencies'/);
  assert.match(script, /'--skip-prepublish'/);
});

test('VSIX smoke validation keeps existsSync available for the packaged VSIX check', () => {
  const script = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8');

  assert.match(script, /\{[^}]*existsSync[^}]*\}\s*=\s*require\('fs'\)/);
  assert.match(script, /if \(!existsSync\(smokeVsixPath\)\) throw new Error\('\[smoke\] VSIX not found'\);/);
});

test('VSIX smoke validation rejects an embedded plugin payload', () => {
  const script = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8');

  assert.match(script, /VSIX must not contain an embedded plugin/);
  assert.doesNotMatch(script, /electivus-runner\.cjs/);
});

test('resolveMissingExtensionIds reports missing dependencies instead of relying on local user extensions', () => {
  const output = ['salesforce.salesforcedx-vscode@58.5.0', 'ms-vscode.cpptools@1.24.5'].join('\n');

  assert.deepEqual(
    resolveMissingExtensionIds(
      ['salesforce.salesforcedx-vscode', 'salesforce.salesforcedx-vscode-apex-replay-debugger'],
      output
    ),
    ['salesforce.salesforcedx-vscode-apex-replay-debugger']
  );
});

test('resolveRequiredDevHubConfig ignores the legacy SFDX_AUTH_URL fallback', () => {
  process.env = {
    ...originalEnv,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    SFDX_AUTH_URL: 'legacy-auth-url'
  };
  delete process.env.SF_DEVHUB_AUTH_URL;
  delete process.env.SF_DEVHUB_ALIAS;

  assert.throws(() => resolveRequiredDevHubConfig({ requireConfig: true }), /Missing required Dev Hub configuration/);

  process.env = { ...originalEnv };
});

test('pretestSetup fails fast when scratch setup is enabled without explicit Dev Hub config', async () => {
  process.env = {
    ...originalEnv,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    SF_SETUP_SCRATCH: '1'
  };

  delete process.env.SF_DEVHUB_AUTH_URL;
  delete process.env.SF_DEVHUB_ALIAS;

  await assert.rejects(
    () =>
      pretestSetup(
        'integration',
        {},
        {
          ensureSfCliInstalled: async () => 'sf'
        }
      ),
    /Missing required Dev Hub configuration/
  );

  process.env = { ...originalEnv };
});

test('pretestSetup propagates Dev Hub auth failures instead of continuing', async () => {
  let ensureDefaultScratchCalled = false;

  process.env = {
    ...originalEnv,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    SF_SETUP_SCRATCH: '1',
    SF_DEVHUB_ALIAS: 'ConfiguredDevHub'
  };

  await assert.rejects(
    () =>
      pretestSetup(
        'integration',
        {},
        {
          ensureSfCliInstalled: async () => 'sf',
          ensureDevHub: async () => {
            throw new Error('dev hub auth failed');
          },
          ensureDefaultScratch: async () => {
            ensureDefaultScratchCalled = true;
            return { cleanup: async () => {} };
          }
        }
      ),
    /dev hub auth failed/
  );

  assert.equal(ensureDefaultScratchCalled, false);
  process.env = { ...originalEnv };
});

test('ensureDevHub validates an explicit alias without mutating global CLI config', async () => {
  const calls = [];

  const resolvedAlias = await ensureDevHub(
    'sf',
    { mode: 'alias', alias: 'ConfiguredDevHub' },
    {
      execFileAsync: async (file, args) => {
        calls.push([file, args]);
        return { stdout: '{"status":0,"result":{}}' };
      }
    }
  );

  assert.equal(resolvedAlias.targetOrg, 'ConfiguredDevHub');
  assert.deepEqual(calls, [['sf', ['org', 'display', '--target-org', 'ConfiguredDevHub', '--json']]]);
});

test('local alias authorization rejects unsuccessful JSON before scratch setup', async () => {
  await assert.rejects(
    () =>
      ensureDevHub(
        'sf',
        { mode: 'alias', alias: 'ConfiguredDevHub' },
        {
          execFileAsync: async () => ({ stdout: '{"status":1,"message":"sensitive-credential"}' })
        }
      ),
    error => {
      assert.match(error.message, /SF_DEVHUB_ALIAS is not authenticated/);
      assert.doesNotMatch(error.stack, /sensitive-credential/);
      return true;
    }
  );
});

test('legacy sfdx adapter authenticates the explicit alias with its supported command', async () => {
  const session = await ensureDevHub(
    'sfdx',
    { mode: 'alias', alias: 'ConfiguredDevHub' },
    {
      execFileAsync: async (file, args) => {
        assert.equal(file, 'sfdx');
        assert.deepEqual(args, ['force:org:display', '-u', 'ConfiguredDevHub', '--json']);
        return { stdout: '{"status":0,"result":{}}' };
      }
    }
  );
  assert.equal(session.targetOrg, 'ConfiguredDevHub');
});

test('legacy sfdx adapter preserves JWT identity and key cleanup with legacy flags', async t => {
  let keyFile;
  const session = await ensureDevHub(
    'sfdx',
    {
      mode: 'jwt',
      clientId: 'test-client',
      username: 'selected@example.com',
      loginUrl: 'https://login.salesforce.com',
      privateKey: testPrivateKey
    },
    {
      execFileAsync: async (file, args, options) => {
        assert.equal(file, 'sfdx');
        assert.equal(args[0], 'force:auth:jwt:grant');
        keyFile = args[args.indexOf('--jwtkeyfile') + 1];
        assert.deepEqual(args, [
          'force:auth:jwt:grant',
          '--clientid',
          'test-client',
          '--username',
          'selected@example.com',
          '--instanceurl',
          'https://login.salesforce.com',
          '--jwtkeyfile',
          keyFile,
          '--json'
        ]);
        assert.equal(fs.existsSync(keyFile), true);
        assert.equal(options.env.SF_TEMP_SHOW_SECRETS, undefined);
        return { stdout: '{"status":0,"result":{"username":"selected@example.com"}}' };
      }
    }
  );
  t.after(() => session.cleanup());
  assert.equal(session.targetOrg, 'selected@example.com');
  await session.cleanup();
  assert.equal(fs.existsSync(keyFile), false);
});
