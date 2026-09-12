const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { main } = require('./devhub-local');

async function operatorFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.homedir(), 'alv-operator-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openssl = [
    'openssl',
    path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/usr/bin/openssl.exe'),
    path.join(process.env.ProgramFiles || '', 'Git/usr/bin/openssl.exe')
  ].find(binary => require('cross-spawn').sync(binary, ['version'], { windowsHide: true }).status === 0);
  assert.ok(openssl);
  const material = await require('./devhub-identity').main([
    'create-certificate',
    '--state-dir',
    directory,
    '--credential-mode',
    'permanent',
    '--certificate-days',
    '365',
    '--policy-reference',
    'controlled-test',
    '--storage-policy',
    'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
    '--openssl',
    openssl
  ]);
  const inputsFile = path.join(directory, 'jwt-inputs.json');
  const username = 'operator@example.com';
  fs.writeFileSync(
    inputsFile,
    JSON.stringify({
      username,
      clientId: 'fixture-client-key',
      loginUrl: 'https://login.salesforce.com',
      privateKeyFile: material.privateKeyFile
    }),
    { mode: 0o600 }
  );
  const state = {
    version: 1,
    owner: '11111111-1111-4111-8111-111111111111',
    org: '00D000000000001AAA',
    userId: '005000000000001AAA',
    username,
    apps: {
      permanent: {
        ...material,
        configured: true,
        inputsFile,
        name: 'ALV_DevHub_1111111111114111_CI',
        marker: 'alv-devhub:11111111-1111-4111-8111-111111111111:permanent',
        lifecycle: {
          mode: 'permanent',
          days: 365,
          policyReference: 'controlled-test',
          storagePolicy: 'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY'
        }
      }
    }
  };
  fs.writeFileSync(path.join(directory, 'identity.json'), JSON.stringify(state), { mode: 0o600 });
  const homes = [];
  const sf = async (args, options) => {
    const home = options.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    if (args.slice(0, 3).join(' ') === 'org login jwt') {
      assert.notEqual(home, os.homedir());
      assert.equal(fs.existsSync(path.join(home, '.sf')), false);
      homes.push(home);
      return { username, orgId: state.org };
    }
    assert.deepEqual(args.slice(0, 2), ['data', 'query']);
    if (args.includes('SELECT Id FROM Organization'))
      throw new Error('INVALID_TYPE: The minimum Integration identity cannot query Organization.');
    return {
      done: true,
      totalSize: 1,
      records: [{ Id: state.userId, Username: username }]
    };
  };
  return { directory, material, state, sf, homes };
}

test('local JWT verification rejects a temporary operator root before Salesforce access', async () => {
  const { main } = require('./devhub-local');
  let calls = 0;
  await assert.rejects(
    () =>
      main(['verify', '--state-dir', path.join(os.tmpdir(), 'alv-operator')], {
        sf: async () => {
          calls++;
        }
      }),
    /durable/
  );
  assert.equal(calls, 0);
});

test('permanent certificate creation refuses temporary storage before producing credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-storage-rejection-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      require('./devhub-identity').main([
        'create-certificate',
        '--state-dir',
        directory,
        '--credential-mode',
        'permanent',
        '--certificate-days',
        '365',
        '--policy-reference',
        'controlled-test',
        '--storage-policy',
        'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
        '--openssl',
        'must-not-run'
      ]),
    /durable/
  );
});

test('local operator commands reject platform cache roots before reading or creating credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.homedir(), 'alv-storage-policy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  for (const relative of ['.cache', 'Library/Caches', 'AppData/Local/Packages/Fixture/LocalCache']) {
    const directory = path.join(root, relative, 'devhub-jwt');
    fs.mkdirSync(directory, { recursive: true });
    await assert.rejects(main(['verify', '--state-dir', directory], { sf: async () => calls++ }), /outside temporary/);
    const candidate = path.join(directory, 'candidate');
    await assert.rejects(
      require('./devhub-identity').main([
        'create-certificate',
        '--state-dir',
        candidate,
        '--credential-mode',
        'permanent',
        '--certificate-days',
        '365',
        '--policy-reference',
        'controlled-test',
        '--storage-policy',
        'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
        '--openssl',
        'must-not-run'
      ]),
      /outside temporary/
    );
    assert.equal(fs.existsSync(candidate), false);
  }
  assert.equal(calls, 0);
});

test('repeated local JWT verification uses empty homes and preserves the durable journal and key', async t => {
  const fixture = await operatorFixture(t);
  const key = fs.readFileSync(fixture.material.privateKeyFile);
  const journal = fs.readFileSync(path.join(fixture.directory, 'identity.json'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const receipt = await main(['verify', '--state-dir', fixture.directory], fixture);
    assert.equal(receipt.status, 'jwt-verified');
    assert.equal(receipt.orgId, fixture.state.org);
    assert.equal(receipt.userId, fixture.state.userId);
    assert.equal(receipt.isolatedStateRemoved, true);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-client-key|PRIVATE KEY/);
  }
  assert.equal(new Set(fixture.homes).size, 2);
  assert.equal(
    fixture.homes.every(home => !fs.existsSync(home)),
    true
  );
  assert.deepEqual(fs.readFileSync(fixture.material.privateKeyFile), key);
  assert.deepEqual(fs.readFileSync(path.join(fixture.directory, 'identity.json')), journal);
});

test('local run verifies JWT then scopes durable input references to the requested child', async t => {
  const fixture = await operatorFixture(t);
  const original = { ...process.env };
  let calls = 0;
  const result = await main(
    ['run', '--state-dir', fixture.directory, '--', 'node', 'scripts/run-tests.js', '--scope=unit'],
    {
      ...fixture,
      runChild: async (file, args, options) => {
        calls++;
        assert.equal(fixture.homes.length, 1);
        assert.equal(fs.existsSync(fixture.homes[0]), false);
        assert.equal(file, 'node');
        assert.deepEqual(args, ['scripts/run-tests.js', '--scope=unit']);
        assert.equal(options.env.SF_DEVHUB_PRIVATE_KEY_FILE, fixture.material.privateKeyFile);
        assert.equal(options.env.SF_DEVHUB_PRIVATE_KEY, undefined);
        assert.equal(options.env.SF_DEVHUB_ALIAS, undefined);
        assert.equal(options.env.SF_DEVHUB_AUTH_URL, undefined);
        assert.equal(options.env.NODE_EXTRA_CA_CERTS, original.NODE_EXTRA_CA_CERTS);
        return 17;
      }
    }
  );
  assert.equal(result.exitCode, 17);
  assert.equal(calls, 1);
  assert.equal(
    JSON.stringify({ ...process.env }) === JSON.stringify(original),
    true,
    'Parent environment must be unchanged'
  );
  assert.equal(fs.existsSync(fixture.material.privateKeyFile), true);
});

for (const invalid of ['ownership', 'outside-reference', 'missing-key', 'partial-inputs']) {
  test(`local JWT rejects ${invalid} before authentication or child execution`, async t => {
    const fixture = await operatorFixture(t);
    const app = fixture.state.apps.permanent;
    if (invalid === 'ownership') fixture.state.owner = 'fabricated';
    if (invalid === 'outside-reference') app.inputsFile = path.join(os.tmpdir(), 'foreign-operator-inputs.json');
    if (invalid === 'missing-key') fs.unlinkSync(fixture.material.privateKeyFile);
    if (invalid === 'partial-inputs')
      fs.writeFileSync(app.inputsFile, JSON.stringify({ username: fixture.state.username }));
    fs.writeFileSync(path.join(fixture.directory, 'identity.json'), JSON.stringify(fixture.state));
    let calls = 0;
    await assert.rejects(
      main(['run', '--state-dir', fixture.directory, '--', 'node', '--version'], {
        sf: async () => {
          calls++;
        },
        runChild: async () => {
          calls++;
        }
      }),
      /ownership|missing|invalid|differ|unavailable/i
    );
    assert.equal(calls, 0);
  });
}

test('local JWT API verification rejects contradictory identity evidence and cleans its home on failure', async t => {
  const fixture = await operatorFixture(t);
  for (const invalid of ['wrong-org', 'wrong-user', 'incomplete', 'contradictory']) {
    let childCalls = 0;
    const sf = async (args, options) => {
      const result = await fixture.sf(args, options);
      if (args[2] === 'jwt' && invalid === 'wrong-org') result.orgId = '00D000000000002AAA';
      if (args[0] === 'data') {
        if (invalid === 'wrong-user') result.records[0].Username = 'another@example.com';
        if (invalid === 'incomplete') result.done = false;
        if (invalid === 'contradictory') result.totalSize = 0;
      }
      return result;
    };
    await assert.rejects(
      main(['run', '--state-dir', fixture.directory, '--', 'node', '--version'], {
        sf,
        runChild: async () => {
          childCalls++;
        }
      }),
      /JWT.*(?:identity|evidence)|JWT login failed/
    );
    assert.equal(childCalls, 0);
    assert.equal(
      fixture.homes.every(home => !fs.existsSync(home)),
      true
    );
    assert.equal(fs.existsSync(fixture.material.privateKeyFile), true);
  }
});

test('local operator state rejects synchronized folders, Git checkouts and junctions', async t => {
  const fixture = await operatorFixture(t);
  const syncRoot = path.join(fixture.directory, 'OneDrive - Fixture');
  fs.mkdirSync(syncRoot);
  await assert.rejects(main(['verify', '--state-dir', syncRoot]), /durable/);
  const gitRoot = path.join(fixture.directory, 'checkout');
  fs.mkdirSync(gitRoot);
  fs.writeFileSync(path.join(gitRoot, '.git'), 'gitdir: fixture');
  await assert.rejects(main(['verify', '--state-dir', gitRoot]), /Git checkout/);
  const link = path.join(fixture.directory, 'linked');
  fs.symlinkSync(
    path.dirname(fixture.material.privateKeyFile),
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(main(['verify', '--state-dir', link]), /links or junctions/);
  fs.unlinkSync(link);
});

test(
  'Windows JWT copies use a protected private directory before CLI login',
  { skip: process.platform !== 'win32' },
  async t => {
    const fixture = await operatorFixture(t);
    let protectedDirectory = false;
    const sf = async (args, options) => {
      if (args[2] === 'jwt') {
        const check = require('cross-spawn').sync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Console]::Write([System.IO.Directory]::GetAccessControl($env:ALV_ACL_CHECK).AreAccessRulesProtected)'
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env, ALV_ACL_CHECK: options.env.USERPROFILE }
          }
        );
        protectedDirectory = check.status === 0 && check.stdout === 'True';
      }
      return fixture.sf(args, options);
    };
    await main(['verify', '--state-dir', fixture.directory], { sf });
    assert.equal(protectedDirectory, true);
  }
);
