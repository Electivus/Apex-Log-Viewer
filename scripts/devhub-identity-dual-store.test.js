const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const { main } = require('./devhub-identity');
const {
  baseArgs,
  rotationFixture,
  discoveryFixture,
  temporaryCertificate,
  preparedAppFixture,
  addRuntimeAssignment
} = require('./devhub-identity-fixtures');

test('rotation preparation validates replacement and rollback material without changing the app, store or grants', async t => {
  const { fixture, directory, deployments } = await preparedAppFixture(t, 'permanent');
  const state = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  addRuntimeAssignment(fixture, state);
  writeFileSync(path.join(directory, 'identity.json'), JSON.stringify(state));
  const replacement = await temporaryCertificate(t);
  const before = JSON.stringify(fixture.records);
  const deploysBefore = deployments();
  fixture.gh = async args => {
    assert.deepEqual(args, [
      'secret',
      'list',
      '--repo',
      'Electivus/Apex-Log-Viewer',
      '--app',
      'actions',
      '--json',
      'name,updatedAt'
    ]);
    return ['CLIENT_ID', 'USERNAME', 'LOGIN_URL', 'PRIVATE_KEY'].map(name => ({
      name: `SF_DEVHUB_${name}`,
      updatedAt: '2026-09-07T12:00:00Z'
    }));
  };
  const result = await main(
    [
      'prepare-rotation',
      ...baseArgs.slice(1),
      '--state-dir',
      directory,
      '--credential-mode',
      'permanent',
      '--certificate-days',
      '2',
      '--storage-policy',
      'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
      '--policy-reference',
      'fixture-rotation-approval',
      '--expected-fingerprint',
      state.apps.permanent.fingerprint,
      '--certificate-file',
      replacement.certificateFile,
      '--private-key-file',
      replacement.privateKeyFile
    ],
    fixture
  );
  assert.equal(result.status, 'rotation-prepared');
  assert.equal(result.fingerprint, replacement.fingerprint);
  assert.equal(result.rollbackAvailable, true);
  assert.equal(deployments(), deploysBefore);
  assert.equal(JSON.stringify(fixture.records), before);
  const saved = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  assert.equal(saved.rotation.phase, 'prepared');
  assert.equal(saved.apps.permanent.fingerprint, state.apps.permanent.fingerprint);
  assert.doesNotMatch(
    JSON.stringify(result) + JSON.stringify(saved),
    /BEGIN PRIVATE KEY|fixture-consumer-secret|fixture-client-key/
  );
});

async function dualStoreFixture(t) {
  const setup = await rotationFixture(t);
  setup.prepareArgs[setup.prepareArgs.indexOf('--storage-policy') + 1] =
    'github-actions-dependabot-secrets:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY';
  const stores = Object.fromEntries(
    ['actions', 'dependabot'].map(app => [
      app,
      [
        { name: 'SF_DEVHUB_CLIENT_ID', value: 'fixture-client-key' },
        { name: 'SF_DEVHUB_USERNAME', value: setup.state.username },
        { name: 'SF_DEVHUB_LOGIN_URL', value: 'https://login.salesforce.com' },
        { name: 'SF_DEVHUB_PRIVATE_KEY', value: readFileSync(setup.state.apps.permanent.privateKeyFile, 'utf8') }
      ].map(item => ({ ...item, updatedAt: '2026-09-07T12:00:00Z' }))
    ])
  );
  const deliveries = [];
  setup.fixture.gh = async (args, options) => {
    const app = args[args.indexOf('--app') + 1];
    assert.ok(stores[app], 'Only the two approved GitHub scopes may be accessed');
    assert.equal(args[args.indexOf('--repo') + 1], 'Electivus/Apex-Log-Viewer');
    if (args[1] === 'list') return stores[app].map(({ name, updatedAt }) => ({ name, updatedAt }));
    assert.deepEqual(args.slice(0, 3), ['secret', 'set', 'SF_DEVHUB_PRIVATE_KEY']);
    assert.equal(
      new X509Certificate(readFileSync(setup.fixture.activeCertificateFile)).checkPrivateKey(
        createPrivateKey(options.input)
      ),
      true,
      'Each delivered key must match the active certificate'
    );
    deliveries.push(app);
    setup.changes.store += 1;
    Object.assign(
      stores[app].find(item => item.name === 'SF_DEVHUB_PRIVATE_KEY'),
      {
        value: options.input,
        updatedAt: new Date(Date.UTC(2026, 8, 7, 13, 0, deliveries.length)).toISOString()
      }
    );
  };
  return { ...setup, stores, deliveries };
}

test('explicit dual-store rotation upgrades Actions-only state and delivers only the private key to both scopes', async t => {
  const setup = await dualStoreFixture(t);
  const unchanged = Object.fromEntries(
    Object.entries(setup.stores).map(([app, records]) => [
      app,
      records.filter(item => item.name !== 'SF_DEVHUB_PRIVATE_KEY').map(item => ({ ...item }))
    ])
  );
  const prepared = await main(setup.prepareArgs, setup.fixture);
  assert.equal(prepared.activeAppChanged, false);
  assert.equal(setup.changes.store, 0);
  const args = [
    'apply-rotation',
    ...baseArgs.slice(1),
    '--state-dir',
    setup.directory,
    '--rotation-id',
    prepared.rotationId
  ];
  const result = await main(args, setup.fixture);
  assert.equal(result.status, 'rotation-applied');
  assert.equal(result.ciVerified, false);
  for (const app of ['actions', 'dependabot']) {
    assert.equal(
      setup.stores[app].find(item => item.name === 'SF_DEVHUB_PRIVATE_KEY').value,
      readFileSync(setup.replacement.privateKeyFile, 'utf8')
    );
    assert.deepEqual(
      setup.stores[app].filter(item => item.name !== 'SF_DEVHUB_PRIVATE_KEY'),
      unchanged[app]
    );
  }
  assert.deepEqual(setup.deliveries, ['actions', 'dependabot']);
  assert.equal(setup.changes.app, 1);
  assert.equal(setup.changes.logins, 2);
  await main(args, setup.fixture);
  assert.deepEqual(
    setup.deliveries,
    ['actions', 'dependabot'],
    'Completed verification must not repeat either delivery'
  );
  assert.doesNotMatch(
    JSON.stringify(result) + JSON.stringify(setup.read()),
    /BEGIN PRIVATE KEY|fixture-consumer-secret|fixture-client-key/
  );
});

for (const scope of ['actions', 'dependabot'])
  for (const boundary of ['before', 'after']) {
    test(`dual-store forward recovery reconciles interruption ${boundary} ${scope} delivery`, async t => {
      const setup = await dualStoreFixture(t);
      const prepared = await main(setup.prepareArgs, setup.fixture);
      const gh = setup.fixture.gh;
      let interrupt = true;
      setup.fixture.gh = async (args, options) => {
        if (interrupt && args[1] === 'set' && args.at(-1) === scope) {
          interrupt = false;
          if (boundary === 'after') await gh(args, options);
          throw new Error('lost response fixture-consumer-secret BEGIN PRIVATE KEY');
        }
        return gh(args, options);
      };
      const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
      await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /output withheld/);
      assert.equal(setup.read().rotation.phase, 'store-update-pending');
      if (scope === 'dependabot') {
        const confirmed = setup.stores.actions.find(item => item.name === 'SF_DEVHUB_PRIVATE_KEY');
        const recordedTime = confirmed.updatedAt;
        confirmed.updatedAt = '2026-09-08T12:00:00Z';
        await assert.rejects(
          main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture),
          /Secret inventory differs/
        );
        confirmed.updatedAt = recordedTime;
      }
      const result = await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
      assert.equal(result.status, 'rotation-applied');
      assert.equal(setup.changes.app, 1);
      const expected =
        boundary === 'before'
          ? ['actions', 'dependabot']
          : scope === 'actions'
            ? ['actions', 'actions', 'dependabot']
            : ['actions', 'dependabot', 'dependabot'];
      assert.deepEqual(setup.deliveries, expected);
      for (const app of ['actions', 'dependabot'])
        assert.equal(
          setup.stores[app].find(item => item.name === 'SF_DEVHUB_PRIVATE_KEY').value,
          readFileSync(setup.replacement.privateKeyFile, 'utf8')
        );
      await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
      assert.deepEqual(setup.deliveries, expected);
    });
  }

test('dual-store rotation rejects input drift before writes and recorded key drift after completion', async t => {
  const setup = await dualStoreFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const args = [
    'apply-rotation',
    ...baseArgs.slice(1),
    '--state-dir',
    setup.directory,
    '--rotation-id',
    prepared.rotationId
  ];
  for (const records of Object.values(setup.stores)) {
    for (const item of records) {
      const approvedTime = item.updatedAt;
      item.updatedAt = '2026-09-08T12:00:00Z';
      await assert.rejects(main(args, setup.fixture), /Secret inventory differs/);
      assert.equal(setup.changes.app, 0);
      assert.equal(setup.deliveries.length, 0);
      item.updatedAt = approvedTime;
    }
  }
  await main(args, setup.fixture);
  for (const records of Object.values(setup.stores)) {
    for (const item of records) {
      const recordedTime = item.updatedAt;
      item.updatedAt = '2026-09-09T12:00:00Z';
      await assert.rejects(main(args, setup.fixture), /Secret inventory differs/);
      assert.equal(setup.changes.app, 1);
      assert.equal(setup.deliveries.length, 2, 'Completed replay must not repair unrelated Secret drift');
      item.updatedAt = recordedTime;
    }
  }
});

test('dual-store rollback restores both stores selected by an upgrade from Actions-only material', async t => {
  const setup = await dualStoreFixture(t);
  const previousKey = readFileSync(setup.state.apps.permanent.privateKeyFile, 'utf8');
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const gh = setup.fixture.gh;
  let interrupt = true;
  setup.fixture.gh = async (args, options) => {
    if (interrupt && args[1] === 'set' && args.at(-1) === 'dependabot') {
      interrupt = false;
      throw new Error('controlled delivery failure');
    }
    return gh(args, options);
  };
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
  await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /output withheld/);
  const result = await main(['recover-rotation', ...args, '--recovery-direction', 'rollback'], setup.fixture);
  assert.equal(result.status, 'rotation-rolled-back');
  assert.equal(result.fingerprint, setup.state.apps.permanent.fingerprint);
  assert.deepEqual(setup.deliveries, ['actions', 'actions', 'dependabot']);
  for (const records of Object.values(setup.stores))
    assert.equal(records.find(item => item.name === 'SF_DEVHUB_PRIVATE_KEY').value, previousKey);
  await main(['recover-rotation', ...args, '--recovery-direction', 'rollback'], setup.fixture);
  assert.equal(setup.deliveries.length, 3);
  assert.equal(setup.changes.app, 2);
  const downgrade = [...setup.prepareArgs];
  downgrade[downgrade.indexOf('--storage-policy') + 1] = setup.state.apps.permanent.lifecycle.storagePolicy;
  await assert.rejects(main(downgrade, setup.fixture), /remove a previously selected scope/);
  assert.equal(setup.changes.app, 2);
  assert.equal(setup.deliveries.length, 3, 'Rollback must not authorize dropping Dependabot on the next rotation');
  const next = await main(setup.prepareArgs, setup.fixture);
  assert.equal(next.status, 'rotation-prepared');
  assert.equal(setup.read().rotationHistory.at(-1).previous.lifecycle.storagePolicy,
    setup.state.apps.permanent.lifecycle.storagePolicy, 'Historical material policy remains unchanged');
});

test('dual-store preparation rejects missing or contradictory inputs in either scope and unauthorized policy changes', async t => {
  const setup = await dualStoreFixture(t);
  const gh = setup.fixture.gh;
  for (const scope of ['actions', 'dependabot'])
    for (const invalid of ['missing', 'duplicate', 'timestamp']) {
      setup.fixture.gh = async (args, options) => {
        const result = await gh(args, options);
        if (args[1] !== 'list' || args[args.indexOf('--app') + 1] !== scope) return result;
        if (invalid === 'missing') return result.filter(item => item.name !== 'SF_DEVHUB_USERNAME');
        if (invalid === 'duplicate') return [...result, { name: 'SF_DEVHUB_USERNAME', updatedAt: 'invalid' }];
        return result.map(item => (item.name === 'SF_DEVHUB_USERNAME' ? { ...item, updatedAt: 'invalid' } : item));
      };
      await assert.rejects(main(setup.prepareArgs, setup.fixture), /all four JWT inputs/);
      assert.equal(setup.changes.app, 0);
      assert.equal(setup.deliveries.length, 0);
    }
  setup.fixture.gh = gh;
  const otherRepository = [...setup.prepareArgs];
  otherRepository[otherRepository.indexOf('--storage-policy') + 1] =
    'github-actions-dependabot-secrets:Electivus/Another-Repository/SF_DEVHUB_PRIVATE_KEY';
  await assert.rejects(main(otherRepository, setup.fixture), /cannot change repository/);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  await main(
    ['apply-rotation', ...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId],
    setup.fixture
  );
  const downgrade = [...setup.prepareArgs];
  downgrade[downgrade.indexOf('--storage-policy') + 1] = setup.state.apps.permanent.lifecycle.storagePolicy;
  downgrade[downgrade.indexOf('--expected-fingerprint') + 1] = setup.replacement.fingerprint;
  downgrade[downgrade.indexOf('--certificate-file') + 1] = setup.state.apps.permanent.certificateFile;
  downgrade[downgrade.indexOf('--private-key-file') + 1] = setup.state.apps.permanent.privateKeyFile;
  await assert.rejects(main(downgrade, setup.fixture), /remove a previously selected scope/);
  assert.equal(setup.changes.app, 1);
  assert.equal(setup.deliveries.length, 2);
});

test('dual-store lost-material recovery binds both inventories and preserves forward-only recovery across partial delivery', async t => {
  const setup = await dualStoreFixture(t);
  setup.fixture.observedApp = { ...setup.state.apps.permanent };
  const directory = path.join(setup.directory, 'dual-recovered-state');
  const args = [
    ...setup.prepareArgs,
    '--expected-app-name',
    setup.state.apps.permanent.name,
    '--lost-state-dir',
    path.join(setup.directory, 'missing-original')
  ];
  args[0] = 'prepare-lost-material-recovery';
  args[args.indexOf('--state-dir') + 1] = directory;
  const prepared = await main(args, setup.fixture);
  const plan = JSON.parse(readFileSync(path.join(directory, 'recovery-plan.json'), 'utf8'));
  assert.equal(plan.storeInventory.length, 8);
  assert.deepEqual([...new Set(plan.storeInventory.map(item => item.app))], ['actions', 'dependabot']);
  assert.equal(prepared.rollbackAvailable, false);
  const gh = setup.fixture.gh;
  let interrupt = true;
  setup.fixture.gh = async (args, options) => {
    const result = await gh(args, options);
    if (interrupt && args[1] === 'set' && args.at(-1) === 'actions') {
      interrupt = false;
      throw new Error('uncertain first delivery');
    }
    return result;
  };
  const apply = [
    'apply-lost-material-recovery',
    ...baseArgs.slice(1),
    '--state-dir',
    directory,
    '--approved-plan-sha256',
    prepared.planSha256,
    '--policy-reference',
    'controlled-dual-store-approval'
  ];
  await assert.rejects(main(apply, setup.fixture), /output withheld/);
  const loginInput = setup.stores.dependabot.find(item => item.name === 'SF_DEVHUB_USERNAME');
  const baselineTime = loginInput.updatedAt;
  loginInput.updatedAt = '2026-09-09T12:00:00Z';
  await assert.rejects(main(apply, setup.fixture), /Secret inventory differs.*approved recovery plan/);
  assert.deepEqual(setup.deliveries, ['actions']);
  loginInput.updatedAt = baselineTime;
  const result = await main(apply, setup.fixture);
  assert.equal(result.status, 'rotation-applied');
  assert.equal(result.rollbackAvailable, false);
  assert.deepEqual(setup.deliveries, ['actions', 'actions', 'dependabot']);
  await main(apply, setup.fixture);
  assert.equal(setup.deliveries.length, 3);
  setup.stores.dependabot.find(item => item.name === 'SF_DEVHUB_PRIVATE_KEY').updatedAt = '2026-09-10T12:00:00Z';
  await assert.rejects(main(apply, setup.fixture), /Secret inventory differs.*approved recovery plan/);
  assert.equal(setup.deliveries.length, 3);
  const journal = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  assert.equal(journal.recovery.historicalPhases, 'unknown');
  assert.equal(journal.recovery.previousPrivateKeyAvailable, false);
  await assert.rejects(
    main(
      [
        'recover-rotation',
        ...baseArgs.slice(1),
        '--state-dir',
        directory,
        '--rotation-id',
        prepared.recoveryId,
        '--recovery-direction',
        'rollback'
      ],
      setup.fixture
    ),
    /rollback.*unavailable/i
  );
});

function directoryPermissions(directory) {
  const fs = require('node:fs');
  if (process.platform !== 'win32') return fs.statSync(directory).mode & 0o777;
  const result = require('cross-spawn').sync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[System.IO.Directory]::GetAccessControl($env:ALV_TEST_ACL_DIRECTORY).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, ALV_TEST_ACL_DIRECTORY: directory } });
  assert.equal(result.status, 0, 'Read-only ACL inspection must succeed');
  return result.stdout.trim();
}

test('lost-material recovery preparation preserves unrelated existing directories', async t => {
  const fs = require('node:fs');
  const directory = mkdtempSync(path.join(homedir(), 'alv-unrelated-preparation-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o750);
  const before = directoryPermissions(directory);
  const candidate = await temporaryCertificate(t);
  const args = ['prepare-lost-material-recovery', ...baseArgs.slice(1), '--state-dir', directory,
    '--expected-app-name', 'ALV_DevHub_1111111111114111_CI', '--expected-fingerprint', Array(32).fill('00').join(':'),
    '--lost-state-dir', path.join(directory, 'missing-original'), '--credential-mode', 'permanent',
    '--certificate-days', '2', '--storage-policy', 'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
    '--policy-reference', 'controlled-preparation', '--certificate-file', candidate.certificateFile,
    '--private-key-file', candidate.privateKeyFile];
  for (const marker of [undefined, '{invalid', JSON.stringify({ version: 1, kind: 'unrelated' })]) {
    if (marker !== undefined) writeFileSync(path.join(directory, 'recovery-preparation.json'), marker, { mode: 0o600 });
    const files = fs.readdirSync(directory);
    await assert.rejects(main(args, discoveryFixture()));
    assert.equal(directoryPermissions(directory), before, 'Preparation must not change an unrelated directory ACL');
    assert.deepEqual(fs.readdirSync(directory), files, 'Preparation must not add artifacts to an unrelated directory');
    if (marker !== undefined) assert.equal(readFileSync(path.join(directory, 'recovery-preparation.json'), 'utf8'), marker);
  }
});

test('lost-material recovery rejects an unrecognized plan without changing directory permissions', async t => {
  const fs = require('node:fs');
  const directory = mkdtempSync(path.join(homedir(), 'alv-unrelated-recovery-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o750);
  const before = directoryPermissions(directory);
  for (const { body, approvedHash } of [
    {},
    { body: '{invalid' },
    { body: JSON.stringify({ version: 1, kind: 'unrelated' }) },
    { body: '{}', approvedHash: '0'.repeat(64) }
  ]) {
    if (body !== undefined) writeFileSync(path.join(directory, 'recovery-plan.json'), body, { mode: 0o600 });
    const files = fs.readdirSync(directory);
    const approved = approvedHash || require('node:crypto').createHash('sha256').update(body || '').digest('hex');
    await assert.rejects(main(['apply-lost-material-recovery', ...baseArgs.slice(1), '--state-dir', directory,
      '--approved-plan-sha256', approved, '--policy-reference', 'controlled-invalid-plan'], discoveryFixture()));
    assert.equal(directoryPermissions(directory), before, 'An unrecognized directory must retain its existing permissions');
    assert.deepEqual(fs.readdirSync(directory), files, 'Rejected input must not create a lock or journal');
    if (body !== undefined) assert.equal(readFileSync(path.join(directory, 'recovery-plan.json'), 'utf8'), body);
  }
});
