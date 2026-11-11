const test = require('node:test');
const assert = require('node:assert/strict');
const { rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { main } = require('./devhub-identity');
const { baseArgs, rotationFixture, temporaryCertificate } = require('./devhub-identity-fixtures');

test('lost-material recovery preserves approved Secret inputs and resumes without invented history', async t => {
  const setup = await rotationFixture(t);
  const { fixture, state, changes, replacement } = setup;
  const directory = path.join(setup.directory, 'recovered-operator-state');
  assert.equal(existsSync(directory), false);
  fixture.observedApp = { ...state.apps.permanent };
  const oldJournal = path.join(directory, 'identity.json');
  const lockFile = path.join(directory, 'operation.lock');
  const lockRecords = [];
  const startedBeforeRecovery = Date.now();
  const store = fixture.gh;
  fixture.gh = async (args, options) => {
    lockRecords.push(readFileSync(lockFile, 'utf8'));
    return store(args, options);
  };
  const preparationArgs = ['prepare-lost-material-recovery', ...baseArgs.slice(1), '--state-dir', directory,
    '--expected-app-name', state.apps.permanent.name, '--expected-fingerprint', state.apps.permanent.fingerprint,
    '--lost-state-dir', path.join(directory, 'lost-original'), '--credential-mode', 'permanent',
    '--certificate-days', '2', '--storage-policy', state.apps.permanent.lifecycle.storagePolicy,
    '--policy-reference', 'controlled-recovery-preparation', '--certificate-file', replacement.certificateFile,
    '--private-key-file', replacement.privateKeyFile];
  const federationId = fixture.records.User[0].FederationIdentifier;
  fixture.records.User[0].FederationIdentifier = 'alv-devhub:fabricated';
  await assert.rejects(main(preparationArgs, fixture), /ownership/);
  assert.equal(existsSync(oldJournal), false);
  assert.equal(changes.app, 0);
  const changedRequest = [...preparationArgs];
  changedRequest[changedRequest.indexOf('--expected-app-name') + 1] = 'ALV_DevHub_other_CI';
  await assert.rejects(main(changedRequest, fixture), /preparation root/);
  fixture.records.User[0].FederationIdentifier = federationId;
  const result = await main(preparationArgs, fixture);
  assert.equal(result.status, 'lost-material-recovery-prepared');
  assert.equal(result.rollbackAvailable, false);
  assert.equal(result.historicalJournalAvailable, false);
  assert.equal(result.activeCredentialChanged, false);
  assert.equal(existsSync(oldJournal), false);
  assert.equal(changes.app, 0);
  assert.equal(changes.store, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|fixture-client-key|fixture-consumer-secret/);
  const applyArgs = ['apply-lost-material-recovery', ...baseArgs.slice(1), '--state-dir', directory];
  await assert.rejects(main(applyArgs, fixture), /approved plan/);
  assert.equal(existsSync(oldJournal), false);
  assert.equal(changes.app, 0);
  const approval = [...applyArgs, '--approved-plan-sha256', result.planSha256, '--policy-reference', 'controlled-active-approval'];
  const planFile = path.join(directory, 'recovery-plan.json');
  const planBytes = readFileSync(planFile);
  require('node:fs').appendFileSync(planFile, '\n');
  await assert.rejects(main(approval, fixture), /differs from the approved plan/);
  assert.equal(changes.app, 0);
  assert.equal(existsSync(oldJournal), false);
  writeFileSync(planFile, planBytes);
  const gh = fixture.gh;
  for (const changedName of ['CLIENT_ID', 'USERNAME', 'LOGIN_URL', 'PRIVATE_KEY']) {
    fixture.gh = async (args, options) => {
      const response = await gh(args, options);
      return args[1] === 'list'
        ? response.map(item => item.name === `SF_DEVHUB_${changedName}`
          ? { ...item, updatedAt: '2026-09-08T12:00:00Z' } : item)
        : response;
    };
    await assert.rejects(main(approval, fixture), /Secret.*approved recovery plan/);
    assert.equal(changes.app, 0, 'Secret drift must stop certificate replacement');
    assert.equal(changes.store, 0, 'Secret drift must stop private-key replacement');
  }
  let interrupted = false;
  let changedNonKeySecret = false;
  fixture.gh = async (args, options) => {
    const response = await gh(args, options);
    if (args[1] === 'list') {
      return response.map(item => (interrupted && item.name === 'SF_DEVHUB_PRIVATE_KEY') ||
        (changedNonKeySecret && item.name === 'SF_DEVHUB_USERNAME')
        ? { ...item, updatedAt: '2026-09-08T12:00:00Z' } : item);
    }
    if (args[1] === 'set' && !interrupted) {
      interrupted = true;
      throw new Error('controlled interruption after Secret delivery');
    }
    return response;
  };
  await assert.rejects(main(approval, fixture), /GitHub credential-store operation failed/);
  assert.equal(JSON.parse(readFileSync(oldJournal, 'utf8')).rotation.phase, 'store-update-pending');
  changedNonKeySecret = true;
  await assert.rejects(main(approval, fixture), /Secret.*approved recovery plan/);
  assert.equal(changes.app, 1);
  assert.equal(changes.store, 1, 'Resume must still reject changes to non-key Secrets');
  changedNonKeySecret = false;
  const applied = await main(approval, fixture);
  assert.equal(applied.status, 'rotation-applied');
  assert.equal(applied.rollbackAvailable, false);
  const recovered = JSON.parse(readFileSync(oldJournal, 'utf8'));
  assert.equal(recovered.owner, state.owner);
  assert.equal(recovered.userId, state.userId);
  assert.equal(recovered.apps.permanent.id, state.apps.permanent.id);
  assert.equal(recovered.recovery.historicalPhases, 'unknown');
  assert.equal(recovered.rotation.phase, 'applied');
  assert.equal(changes.logins, 2, 'Each recovery attempt proves only the new key');
  assert.equal(changes.app, 1);
  assert.equal(changes.store, 2, 'Uncertain Secret delivery is safely rewritten');
  await main(approval, fixture);
  assert.equal(changes.app, 1);
  assert.equal(changes.store, 2);
  const completedStore = fixture.gh;
  fixture.gh = async (args, options) => {
    const response = await completedStore(args, options);
    return args[1] === 'list'
      ? response.map(item => item.name === 'SF_DEVHUB_PRIVATE_KEY'
        ? { ...item, updatedAt: '2026-09-09T12:00:00Z' } : item)
      : response;
  };
  await assert.rejects(main(approval, fixture), /Secret.*approved recovery plan/);
  assert.equal(changes.app, 1, 'A completed recovery must not silently repair later Secret drift');
  assert.equal(changes.store, 2);
  fixture.gh = completedStore;
  const completedJournal = readFileSync(oldJournal);
  const legacyJournal = JSON.parse(completedJournal);
  assert.equal(legacyJournal.rotation.storePrivateKeyUpdatedAt, '2026-09-08T12:00:00Z');
  delete legacyJournal.rotation.storeWrites;
  writeFileSync(oldJournal, JSON.stringify(legacyJournal));
  await main(approval, fixture);
  delete legacyJournal.rotation.storePrivateKeyUpdatedAt;
  writeFileSync(oldJournal, JSON.stringify(legacyJournal));
  await assert.rejects(main(approval, fixture), /Secret.*approved recovery plan/);
  assert.equal(changes.store, 2, 'Missing historical Secret evidence must not be fabricated or authorize a rewrite');
  writeFileSync(oldJournal, completedJournal);
  assert.ok(lockRecords.length > 0);
  for (const body of lockRecords) {
    assert.notEqual(body, '', 'Recovery must record lock ownership before external operations');
    const lock = JSON.parse(body);
    assert.equal(lock.pid, process.pid);
    assert.ok(Date.parse(lock.started) >= startedBeforeRecovery && Date.parse(lock.started) <= Date.now());
  }
  assert.equal(existsSync(lockFile), false);
  await assert.rejects(main(['recover-rotation', ...baseArgs.slice(1), '--state-dir', directory,
    '--rotation-id', result.recoveryId, '--recovery-direction', 'rollback'], fixture), /rollback.*unavailable/i);
});

test('lost-material recovery retains the owned username despite an unrelated same-org collision', async t => {
  const setup = await rotationFixture(t);
  const { fixture, state, replacement, changes } = setup;
  state.username = `apex-log-viewer-ci+${state.owner}@electivus.com`;
  fixture.records.User[0].Username = state.username;
  fixture.records.User.push({
    ...fixture.records.User[0],
    Id: '005000000000002AAA',
    Username: 'apex-log-viewer-ci@electivus.com',
    Email: 'unrelated@example.com',
    FederationIdentifier: null
  });
  fixture.observedApp = { ...state.apps.permanent };
  const directory = path.join(setup.directory, 'recovered-collision-state');
  const prepared = await main(['prepare-lost-material-recovery', ...baseArgs.slice(1), '--state-dir', directory,
    '--expected-app-name', state.apps.permanent.name, '--expected-fingerprint', state.apps.permanent.fingerprint,
    '--lost-state-dir', path.join(directory, 'lost-original'), '--credential-mode', 'permanent',
    '--certificate-days', '2', '--storage-policy', state.apps.permanent.lifecycle.storagePolicy,
    '--policy-reference', 'controlled-collision-recovery', '--certificate-file', replacement.certificateFile,
    '--private-key-file', replacement.privateKeyFile], fixture);
  assert.equal(prepared.activeCredentialChanged, false);
  const plan = JSON.parse(readFileSync(path.join(directory, 'recovery-plan.json'), 'utf8'));
  assert.equal(plan.binding.username, state.username);
  assert.equal(plan.binding.userId, state.userId);
  const applied = await main(['apply-lost-material-recovery', ...baseArgs.slice(1), '--state-dir', directory,
    '--approved-plan-sha256', prepared.planSha256, '--policy-reference', 'controlled-collision-approval'], fixture);
  assert.equal(applied.status, 'rotation-applied');
  assert.equal(changes.app, 1);
  assert.equal(changes.store, 1);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8')).username, state.username);
});

test('legacy Actions delivery uncertainty survives another interruption during forward recovery', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const gh = setup.fixture.gh;
  let delivered = false;
  setup.fixture.gh = async (args, options) => {
    const result = await gh(args, options);
    if (args[1] === 'list') return result.map(item => delivered && item.name === 'SF_DEVHUB_PRIVATE_KEY'
      ? { ...item, updatedAt: '2026-09-08T12:00:00Z' } : item);
    if (!delivered) {
      delivered = true;
      throw new Error('uncertain legacy delivery');
    }
    return result;
  };
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
  await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /output withheld/);
  const journalFile = path.join(setup.directory, 'identity.json');
  const legacy = setup.read();
  delete legacy.rotation.storeWrites;
  legacy.rotation.storeInventory = legacy.rotation.storeInventory.map(({ name, updatedAt }) => ({ name, updatedAt }));
  writeFileSync(journalFile, JSON.stringify(legacy));
  const sf = setup.fixture.sf;
  let interrupt = true;
  setup.fixture.sf = async (args, options) => {
    if (interrupt && args.slice(0, 3).join(' ') === 'org login jwt') {
      interrupt = false;
      throw new Error('second interrupted verification');
    }
    return sf(args, options);
  };
  await assert.rejects(main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture));
  const result = await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
  assert.equal(result.status, 'rotation-applied');
  assert.equal(setup.changes.app, 1);
  assert.equal(setup.changes.store, 2);
});

test('rotation applies only the certificate and private-key Secret, proves fresh JWT, and resumes without repeated mutation', async t => {
  const setup = await rotationFixture(t);
  const { fixture, prepareArgs, changes, read, state, replacement } = setup;
  const before = JSON.stringify(fixture.records);
  const prepared = await main(prepareArgs, fixture);
  const args = [
    'apply-rotation',
    ...baseArgs.slice(1),
    '--state-dir',
    setup.directory,
    '--rotation-id',
    prepared.rotationId
  ];
  const result = await main(args, fixture);
  assert.equal(result.status, 'rotation-applied');
  assert.equal(result.ciVerified, false, 'A local login or Secret timestamp never attests actual CI');
  assert.equal(read().apps.permanent.fingerprint, replacement.fingerprint);
  assert.equal(read().apps.permanent.id, state.apps.permanent.id);
  assert.equal(read().rotation.phase, 'applied');
  assert.equal(JSON.stringify(fixture.records), before, 'Runtime grants and pool records stay intact');
  assert.deepEqual(changes, { app: 1, store: 1, logins: 2 });
  await main(args, fixture);
  assert.equal(changes.app, 1);
  assert.equal(changes.store, 1);
  assert.ok(read().rotation.loginAttempts.every(item => item.cleanup === true && !existsSync(item.directory)));
  assert.doesNotMatch(
    JSON.stringify(result) + JSON.stringify(read()),
    /BEGIN PRIVATE KEY|fixture-consumer-secret|fixture-client-key/
  );
});

test('rotation rejects contradictory fresh API inventories before app or Secret writes and can recover', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const invoke = setup.fixture.sf;
  const user = { Id: setup.state.userId, Username: setup.state.username };
  let response;
  setup.fixture.sf = async (args, options) => {
    if (args[0] === 'data' && options?.env?.SF_STATE_FOLDER === '.sf') return response;
    return invoke(args, options);
  };
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
  for (response of [
    { records: { 0: user, length: 1 }, done: true, totalSize: 1 },
    { records: [user], done: true, totalSize: 2 },
    { records: [user], done: true, totalSize: '1' },
    { records: [user], done: true, totalSize: null }
  ]) {
    await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /did not confirm the dedicated user/);
    assert.equal(setup.changes.app, 0);
    assert.equal(setup.changes.store, 0);
    const attempt = setup.read().rotation.loginAttempts.at(-1);
    assert.equal(attempt.verifiedAt, undefined);
    assert.equal(attempt.cleanup, true);
    assert.equal(existsSync(attempt.directory), false);
  }
  response = { records: [user], done: true };
  const recovered = await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
  assert.equal(recovered.status, 'rotation-applied', 'totalSize remains optional for a complete inventory');
  assert.equal(setup.changes.app, 1);
  assert.equal(setup.changes.store, 1);
});

test('the next approved rotation preserves prior history and uses the current certificate as rollback material', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  await main(
    ['apply-rotation', ...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId],
    setup.fixture
  );
  const next = await temporaryCertificate(t);
  const args = [...setup.prepareArgs];
  args[args.indexOf('--expected-fingerprint') + 1] = setup.replacement.fingerprint;
  args[args.indexOf('--certificate-file') + 1] = next.certificateFile;
  args[args.indexOf('--private-key-file') + 1] = next.privateKeyFile;
  const result = await main(args, setup.fixture);
  assert.notEqual(result.rotationId, prepared.rotationId);
  assert.equal(setup.read().rotationHistory[0].phase, 'applied');
  assert.equal(setup.read().rotation.previous.fingerprint, setup.replacement.fingerprint);
  assert.equal(setup.read().rotation.candidate.fingerprint, next.fingerprint);
});

test('an interrupted certificate replacement blocks other identity mutations until explicit recovery', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const invoke = setup.fixture.sf;
  let interrupt = true;
  setup.fixture.sf = async (args, options) => {
    if (interrupt && args[0] === 'project' && args[1] === 'deploy' && !args.includes('--dry-run')) {
      await invoke(args, options);
      interrupt = false;
      throw new Error('lost response fixture-consumer-secret BEGIN PRIVATE KEY');
    }
    return invoke(args, options);
  };
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory];
  await assert.rejects(
    main(['apply-rotation', ...args, '--rotation-id', prepared.rotationId], setup.fixture),
    /output withheld/
  );
  assert.equal(setup.read().rotation.phase, 'app-update-pending');
  assert.deepEqual(setup.changes, { app: 1, store: 0, logins: 1 });
  await assert.rejects(main(['grant-runtime', ...args], setup.fixture), /Recover the pending certificate rotation/);
  const result = await main(
    ['recover-rotation', ...args, '--rotation-id', prepared.rotationId, '--recovery-direction', 'forward'],
    setup.fixture
  );
  assert.equal(result.status, 'rotation-applied');
  assert.deepEqual(setup.changes, { app: 1, store: 1, logins: 2 });
});

for (const boundary of ['before-app', 'before-store', 'after-store']) {
  test(`rotation recovers forward from interruption ${boundary} with explicit mutation evidence`, async t => {
    const setup = await rotationFixture(t);
    const prepared = await main(setup.prepareArgs, setup.fixture);
    let interrupt = true;
    const sf = setup.fixture.sf;
    const gh = setup.fixture.gh;
    setup.fixture.sf = async (args, options) => {
      if (
        interrupt &&
        boundary === 'before-app' &&
        args[0] === 'project' &&
        args[1] === 'deploy' &&
        !args.includes('--dry-run')
      ) {
        interrupt = false;
        throw new Error('fixture-consumer-secret');
      }
      return sf(args, options);
    };
    setup.fixture.gh = async (args, options) => {
      if (interrupt && boundary !== 'before-app' && args[1] === 'set') {
        interrupt = false;
        if (boundary === 'after-store') await gh(args, options);
        throw new Error('fixture-consumer-secret');
      }
      return gh(args, options);
    };
    const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
    await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /output withheld/);
    assert.equal(
      setup.read().rotation.phase,
      boundary === 'before-app' ? 'app-update-pending' : 'store-update-pending'
    );
    assert.equal(setup.changes.app, boundary === 'before-app' ? 0 : 1);
    assert.equal(setup.changes.store, boundary === 'after-store' ? 1 : 0);
    const recovered = await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
    assert.equal(recovered.status, 'rotation-applied');
    assert.equal(setup.changes.app, 1);
    assert.equal(
      setup.changes.store,
      boundary === 'after-store' ? 2 : 1,
      'An uncertain write-only store response is safely rewritten'
    );
    assert.equal(setup.read().rotation.phase, 'applied');
  });
}

test('rotation rollback restores the prior matching certificate and Secret after a store failure', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const gh = setup.fixture.gh;
  let fail = true;
  setup.fixture.gh = async (args, options) => {
    if (args[1] === 'set' && fail) {
      fail = false;
      throw new Error('fixture-consumer-secret');
    }
    return gh(args, options);
  };
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
  await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /output withheld/);
  const recovered = await main(['recover-rotation', ...args, '--recovery-direction', 'rollback'], setup.fixture);
  assert.equal(recovered.status, 'rotation-rolled-back');
  assert.equal(setup.read().apps.permanent.fingerprint, setup.state.apps.permanent.fingerprint);
  assert.equal(setup.read().rotation.phase, 'rolled-back');
  assert.equal(setup.changes.app, 2);
  assert.equal(setup.changes.store, 1);
});

test('missing rollback key fails without writes while retained candidate permits explicit forward recovery', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const gh = setup.fixture.gh;
  let fail = true;
  setup.fixture.gh = async (args, options) => {
    if (args[1] === 'set' && fail) {
      fail = false;
      throw new Error('fixture-consumer-secret');
    }
    return gh(args, options);
  };
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
  await assert.rejects(main(['apply-rotation', ...args], setup.fixture), /output withheld/);
  rmSync(setup.read().rotation.previous.privateKeyFile);
  const before = { ...setup.changes };
  await assert.rejects(
    main(['recover-rotation', ...args, '--recovery-direction', 'rollback'], setup.fixture),
    /GitHub Secrets cannot return old keys/
  );
  assert.deepEqual(setup.changes, before);
  const recovered = await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
  assert.equal(recovered.status, 'rotation-applied');
  assert.equal(setup.changes.app, 1);
  assert.equal(setup.changes.store, 1);
});

test('invalid rotation lifecycle, missing files and mismatched keys fail before remote calls', async t => {
  const setup = await rotationFixture(t);
  for (const [flag, value, message] of [
    ['--certificate-days', '3', /lifetime differs/],
    ['--certificate-days', '', /Explicit credential lifecycle inputs/],
    ['--policy-reference', '', /Explicit credential lifecycle inputs/],
    ['--private-key-file', path.join(setup.directory, 'missing-key.pem'), /Durable operator state is missing/],
    ['--private-key-file', setup.state.apps.permanent.privateKeyFile, /Certificate\/key mismatch/],
    ['--storage-policy', 'temporary-local', /GitHub.*Secret storage policy/],
    ['--expected-fingerprint', '', /explicit current SHA-256/]
  ]) {
    const args = [...setup.prepareArgs];
    args[args.indexOf(flag) + 1] = value;
    await assert.rejects(
      main(args, {
        sf: async () => assert.fail('Invalid inputs must stop before Salesforce'),
        gh: async () => assert.fail('No GitHub calls')
      }),
      message
    );
  }
});

test('rotation refuses changed live grants without repairing them', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  setup.fixture.records.PermissionSetAssignment.push({
    Id: 'unexpected',
    AssigneeId: '005runtime',
    PermissionSetId: 'unexpected',
    PermissionSetGroupId: null
  });
  const before = JSON.stringify(setup.fixture.records);
  await assert.rejects(
    main(
      ['apply-rotation', ...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId],
      setup.fixture
    ),
    /Runtime administrative grants/
  );
  assert.equal(setup.changes.app, 0);
  assert.equal(setup.changes.store, 0);
  assert.equal(JSON.stringify(setup.fixture.records), before);
});

test('rotation retains the primary JWT failure and cleanup code, then reconciles the owned home before recovery', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const invoke = setup.fixture.sf;
  let loginFails = true;
  setup.fixture.sf = async (args, options) => {
    if (loginFails && args[0] === 'org' && args[1] === 'login') {
      throw new Error('INVALID_GRANT fixture-consumer-secret');
    }
    return invoke(args, options);
  };
  const files = require('node:fs/promises');
  const nativeRemove = files.rm;
  const removal = t.mock.method(files, 'rm', async (directory, options) => {
    if (path.basename(directory).startsWith('jwt-check-')) {
      throw Object.assign(new Error('fixture-consumer-secret'), { code: 'EBUSY' });
    }
    return nativeRemove(directory, options);
  });
  const args = [...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId];
  await assert.rejects(main(['apply-rotation', ...args], setup.fixture), error => {
    assert.match(error.message, /INVALID_GRANT/);
    assert.match(error.message, /cleanup failed \(EBUSY\)/);
    assert.doesNotMatch(error.message, /fixture-consumer-secret/);
    return true;
  });
  const failed = setup.read().rotation.loginAttempts[0];
  assert.equal(failed.cleanup, false);
  assert.equal(failed.cleanupErrorCode, 'EBUSY');
  assert.equal(failed.verifiedAt, undefined);
  assert.equal(setup.changes.app, 0);
  assert.equal(setup.changes.store, 0);
  removal.mock.restore();
  loginFails = false;
  const recovered = await main(['recover-rotation', ...args, '--recovery-direction', 'forward'], setup.fixture);
  assert.equal(recovered.status, 'rotation-applied');
  assert.equal(setup.read().rotation.loginAttempts[0].cleanup, true);
  assert.equal(existsSync(failed.directory), false);
  assert.equal(setup.changes.app, 1);
  assert.equal(setup.changes.store, 1);
});

test('a successful JWT with blocked cleanup stays recorded and stops rotation before active writes', async t => {
  const setup = await rotationFixture(t);
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const files = require('node:fs/promises');
  const nativeRemove = files.rm;
  const removal = t.mock.method(files, 'rm', async (directory, options) => {
    if (path.basename(directory).startsWith('jwt-check-'))
      throw Object.assign(new Error('withheld'), { code: 'EPERM' });
    return nativeRemove(directory, options);
  });
  await assert.rejects(
    main(
      ['apply-rotation', ...baseArgs.slice(1), '--state-dir', setup.directory, '--rotation-id', prepared.rotationId],
      setup.fixture
    ),
    /cleanup failed \(EPERM\)/
  );
  removal.mock.restore();
  const state = setup.read();
  assert.equal(state.rotation.phase, 'prepared');
  assert.ok(state.rotation.loginAttempts[0].verifiedAt);
  assert.equal(state.rotation.loginAttempts[0].cleanup, false);
  assert.equal(state.rotation.loginAttempts[0].failure, undefined);
  assert.deepEqual(setup.changes, { app: 0, store: 0, logins: 1 });
});

test('expired or not-yet-valid replacement fails before remote calls', async t => {
  const setup = await rotationFixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: now + 3 * 86400000 });
  const boundaries = {
    sf: async () => assert.fail('No Salesforce calls'),
    gh: async () => assert.fail('No store calls')
  };
  await assert.rejects(main(setup.prepareArgs, boundaries), /expired certificate or lifetime differs/);
  t.mock.timers.setTime(now - 86400000);
  await assert.rejects(main(setup.prepareArgs, boundaries), /expired certificate or lifetime differs/);
  t.mock.timers.reset();
});

test('rotation refuses live certificate drift, a missing Secret and unknown recovery phase before writes', async t => {
  const setup = await rotationFixture(t);
  const oldCertificate = setup.fixture.activeCertificateFile;
  setup.fixture.activeCertificateFile = setup.replacement.certificateFile;
  await assert.rejects(main(setup.prepareArgs, setup.fixture), /active ECA certificate differs/);
  setup.fixture.activeCertificateFile = oldCertificate;
  const gh = setup.fixture.gh;
  setup.fixture.gh = async () => [];
  await assert.rejects(main(setup.prepareArgs, setup.fixture), /all four JWT inputs/);
  setup.fixture.gh = gh;
  const prepared = await main(setup.prepareArgs, setup.fixture);
  const saved = setup.read();
  saved.rotation.phase = 'unknown-version';
  writeFileSync(path.join(setup.directory, 'identity.json'), JSON.stringify(saved));
  await assert.rejects(
    main(
      [
        'recover-rotation',
        ...baseArgs.slice(1),
        '--state-dir',
        setup.directory,
        '--rotation-id',
        prepared.rotationId,
        '--recovery-direction',
        'forward'
      ],
      setup.fixture
    ),
    /phase or recovery direction is invalid/
  );
  assert.deepEqual(setup.changes, { app: 0, store: 0, logins: 0 });
});
