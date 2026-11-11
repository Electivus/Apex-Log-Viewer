const test = require('node:test');
const assert = require('node:assert/strict');
const { rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const { main } = require('./devhub-identity');
const { ADMINISTRATIVE_PERMISSIONS } = require('./devhub-identity-permissions');
const {
  baseArgs,
  discoveryFixture,
  stateDirectory,
  provisioningFixture,
  temporaryCertificate,
  preparedAppFixture,
  addRuntimeAssignment,
  addRuntimeGrantInventory
} = require('./devhub-identity-fixtures');

test('provisioning refuses an unexpected target before any mutation', async () => {
  const sf = async args => {
    assert.equal(args.slice(0, 3).join(' '), 'data query --target-org');
    return { records: [{ Id: '00D000000000002AAA', IsSandbox: false }], done: true, totalSize: 1 };
  };
  await assert.rejects(main(baseArgs, { sf }), /Target org does not match/);
});

test('inspection reports live minimum-license candidates and unrelated resource ownership without mutation', async () => {
  const { sf } = discoveryFixture();
  const result = await main(baseArgs, { sf });
  assert.deepEqual(result.candidates.integration, {
    licenseId: '100integration',
    profileId: '00eintegration',
    profile: 'Minimum Access - API Only Integrations',
    available: 5,
    permissionSetLicenseId: '0PLintegration',
    permissionSetLicenseAvailable: 5
  });
  assert.equal(result.candidates.salesforce.profile, 'Minimum Access - Salesforce');
  assert.equal(result.scratches[0].OwnerId, 'other-user');
  assert.equal(result.pools[0].ProvisioningMode__c, 'snapshot');
});

test('an exhausted Integration license fails before user creation and does not silently use Salesforce', async t => {
  const fixture = discoveryFixture();
  fixture.records.UserLicense[0].UsedLicenses = 5;
  const directory = stateDirectory(t);
  await assert.rejects(
    main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Integration license capacity/
  );
  assert.equal(existsSync(path.join(directory, 'identity.json')), false);
});

for (const invalid of [{ done: undefined }, { done: false }, { totalSize: 2 }, { totalSize: -1 }, { totalSize: '1' }]) {
  test(`provisioning rejects incomplete initial inventory ${JSON.stringify(invalid)} without mutation`, async t => {
    const fixture = provisioningFixture();
    const read = fixture.sf;
    fixture.sf = async args => {
      const result = await read(args);
      return args.includes('SELECT Id, IsSandbox, OrganizationType FROM Organization')
        ? { ...result, ...invalid }
        : result;
    };
    await assert.rejects(
      main(['provision-user', ...baseArgs.slice(1), '--state-dir', stateDirectory(t)], fixture),
      /Incomplete Salesforce inventory/
    );
    assert.deepEqual(fixture.created, []);
  });
}

test('provisioning resumes its owned Integration user and PSL without duplicate records', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  const args = ['provision-user', ...baseArgs.slice(1), '--state-dir', directory];
  const first = await main(args, fixture);
  assert.equal(first.status, 'user-ready');
  assert.equal(first.user.Username, 'apex-log-viewer-ci@electivus.com');
  assert.equal(first.user.Email, 'apex-log-viewer-ci@electivus.com');
  assert.equal(first.user.ProfileId, '00eintegration');
  const second = await main(args, fixture);
  assert.equal(second.user.Id, first.user.Id);
  assert.deepEqual(
    fixture.created.map(entry => entry.object),
    ['User', 'PermissionSetLicenseAssign']
  );
  const state = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  assert.equal(state.userId, first.user.Id);
  assert.match(first.user.FederationIdentifier, /^alv-devhub:[0-9a-f-]{36}$/);
});

test('a global username collision chooses a unique electivus.com candidate while preserving the contact', async t => {
  const fixture = provisioningFixture();
  const invoke = fixture.sf;
  let collision = true;
  fixture.sf = async args => {
    if (collision && args[1] === 'create' && args.includes('User')) {
      collision = false;
      throw Object.assign(new Error('Remote details must not be disclosed'), { code: 'DUPLICATE_USERNAME' });
    }
    return invoke(args);
  };
  const result = await main(['provision-user', ...baseArgs.slice(1), '--state-dir', stateDirectory(t)], fixture);
  assert.match(result.user.Username, /^apex-log-viewer-ci\+[0-9a-f-]+@electivus\.com$/);
  assert.equal(result.user.Email, 'apex-log-viewer-ci@electivus.com');
  assert.equal(fixture.created.filter(entry => entry.object === 'User').length, 1);
});

test('permanent app provisioning requires an explicit storage and certificate-lifetime decision before any operation', async t => {
  const sf = async () => assert.fail('No remote calls before the permanent credential policy is confirmed');
  await assert.rejects(
    main(['provision-app', ...baseArgs.slice(1), '--state-dir', stateDirectory(t), '--credential-mode', 'permanent'], {
      sf
    }),
    /Explicit credential lifecycle inputs/
  );
});

test('temporary certificate creation honors the explicit lifetime and retains one matching key without overwriting it', async t => {
  const result = await temporaryCertificate(t);
  const certificate = new X509Certificate(readFileSync(result.certificateFile));
  assert.equal(certificate.checkPrivateKey(createPrivateKey(readFileSync(result.privateKeyFile))), true);
  assert.equal((Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) / 86400000, 2);
  assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(result.mode, 'temporary');
  assert.doesNotMatch(JSON.stringify(result), /BEGIN .*PRIVATE KEY/);
});

test(
  'Windows certificate reruns remove unexpected explicit grants before reusing private files',
  { skip: process.platform !== 'win32' },
  async t => {
    const certificate = await temporaryCertificate(t);
    const credentialDirectory = path.dirname(certificate.privateKeyFile);
    const granted = require('cross-spawn').sync('icacls', [credentialDirectory, '/grant', '*S-1-1-0:(OI)(CI)R'], {
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(granted.status, 0, 'The test must establish an explicit Everyone read grant');
    const repeated = await main([
      'create-certificate',
      '--state-dir',
      path.dirname(credentialDirectory),
      '--credential-mode',
      'temporary',
      '--certificate-days',
      '2',
      '--storage-policy',
      'temporary-local'
    ]);
    const checked = require('cross-spawn').sync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.IO.Directory]::GetAccessControl($env:ALV_IDENTITY_TEST_DIRECTORY).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }'
      ],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, ALV_IDENTITY_TEST_DIRECTORY: credentialDirectory } }
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.doesNotMatch(checked.stdout, /S-1-1-0/);
    assert.equal(
      repeated.fingerprint,
      certificate.fingerprint,
      'ACL repair must preserve the original certificate and key'
    );
  }
);

test(
  'Windows private-directory validation refuses an existing child with unexpected explicit access',
  { skip: process.platform !== 'win32' },
  async t => {
    const certificate = await temporaryCertificate(t);
    const granted = require('cross-spawn').sync('icacls', [certificate.privateKeyFile, '/grant', '*S-1-1-0:R'], {
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(granted.status, 0, 'The fixture must establish unexpected explicit file access');
    await assert.rejects(
      main([
        'create-certificate',
        '--state-dir',
        path.dirname(path.dirname(certificate.privateKeyFile)),
        '--credential-mode',
        'temporary',
        '--certificate-days',
        '2',
        '--storage-policy',
        'temporary-local'
      ]),
      /descendant has unexpected access/
    );
  }
);

test('app provisioning does not adopt or overwrite an unrelated app with the planned API name', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  const state = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  fixture.records.ExternalClientApplication.push({
    Id: 'unrelated-app',
    DeveloperName: `ALV_DevHub_${state.owner.replaceAll('-', '').slice(0, 16)}_Test`,
    Description: 'Unrelated owner',
    ContactEmail: 'someone@example.com'
  });
  const certificate = await temporaryCertificate(t);
  await assert.rejects(
    main(
      [
        'provision-app',
        ...baseArgs.slice(1),
        '--state-dir',
        directory,
        '--credential-mode',
        'temporary',
        '--certificate-days',
        '2',
        '--storage-policy',
        'temporary-local',
        '--certificate-file',
        certificate.certificateFile,
        '--private-key-file',
        certificate.privateKeyFile
      ],
      fixture
    ),
    /App ownership conflict/
  );
});

test('a rejected metadata validation leaves app activation and assignments untouched', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  const certificate = await temporaryCertificate(t);
  const invoke = fixture.sf;
  let validated = false;
  fixture.sf = async args => {
    if (args[0] === 'project') {
      assert.equal(args[1], 'deploy');
      assert.ok(args.includes('--dry-run'), 'No live deployment after validation failure');
      validated = true;
      return { success: false, status: 'Failed', id: '0Afvalidation', checkOnly: true };
    }
    return invoke(args);
  };
  await assert.rejects(
    main(
      [
        'provision-app',
        ...baseArgs.slice(1),
        '--state-dir',
        directory,
        '--credential-mode',
        'temporary',
        '--certificate-days',
        '2',
        '--storage-policy',
        'temporary-local',
        '--certificate-file',
        certificate.certificateFile,
        '--private-key-file',
        certificate.privateKeyFile
      ],
      fixture
    ),
    /Metadata validation failed/
  );
  assert.equal(validated, true);
  assert.equal(fixture.records.ExternalClientApplication.length, 0);
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

function addProfileAssignment(fixture) {
  const permission = {
    Id: 'profile-set',
    Name: 'GeneratedProfileSet',
    IsOwnedByProfile: true,
    ProfileId: fixture.records.User[0].ProfileId,
    Type: 'Profile',
    NamespacePrefix: null,
    ...Object.fromEntries(ADMINISTRATIVE_PERMISSIONS.map(name => [name, false]))
  };
  fixture.records.PermissionSet.push(permission);
  fixture.records.PermissionSetAssignment.push({
    Id: 'profile-assignment',
    AssigneeId: '005runtime',
    PermissionSetId: permission.Id,
    PermissionSetGroupId: null
  });
}

test('runtime readiness and proof reject effective drift inside the recognized permission set', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const permission = addRuntimeAssignment(fixture, state);
  addProfileAssignment(fixture);
  state.integrationFailure = { license: 'integration', licenseRestriction: true, affectedObjects: ['ScratchOrgInfo'] };
  fixture.permissionFields.push('PermissionsRunReports');
  for (const set of fixture.records.PermissionSet) set.PermissionsRunReports = false;
  writeFileSync(stateFile, JSON.stringify(state));
  const grants = structuredClone(fixture.runtimeGrants);
  const originalPermission = structuredClone(permission);
  const invoke = fixture.sf;
  for (const scenario of [
    'extra-object',
    'extra-field',
    'extra-apex',
    'extra-custom',
    'extra-user-permission',
    'extra-object-permission',
    'extra-related-grant',
    'missing-object',
    'missing-field',
    'missing-apex',
    'missing-user-permission',
    'unreported-user-permission',
    'unreported-field-permission',
    'duplicate-object',
    'incomplete-query',
    'missing-records',
    'incomplete-schema'
  ]) {
    await t.test(scenario, async () => {
      fixture.runtimeGrants = structuredClone(grants);
      Object.assign(permission, originalPermission);
      const inventory = fixture.runtimeGrants;
      if (scenario === 'extra-object')
        inventory.ObjectPermissions.push({ ...inventory.ObjectPermissions[0], SobjectType: 'Account' });
      if (scenario === 'extra-field')
        inventory.FieldPermissions.push({ ...inventory.FieldPermissions[0], Field: 'Account.Secret__c' });
      if (scenario === 'extra-apex' || scenario === 'extra-custom')
        inventory.SetupEntityAccess.push({
          ParentId: permission.Id,
          SetupEntityId: 'unrelated-entity',
          SetupEntityType: scenario === 'extra-apex' ? 'ApexClass' : 'CustomPermission'
        });
      if (scenario === 'extra-user-permission') permission.PermissionsRunReports = true;
      if (scenario === 'extra-object-permission') inventory.ObjectPermissions[0].PermissionsViewAllFields = true;
      if (scenario === 'extra-related-grant') inventory.PermissionSetTabSetting = [{ Id: 'extra-tab' }];
      if (scenario === 'missing-object') inventory.ObjectPermissions.pop();
      if (scenario === 'missing-field') inventory.FieldPermissions.pop();
      if (scenario === 'missing-apex') inventory.SetupEntityAccess.pop();
      if (scenario === 'missing-user-permission') permission.PermissionsApiEnabled = false;
      if (scenario === 'unreported-user-permission') delete permission.PermissionsRunReports;
      if (scenario === 'unreported-field-permission') delete inventory.FieldPermissions[0].PermissionsEdit;
      if (scenario === 'duplicate-object') inventory.ObjectPermissions.push({ ...inventory.ObjectPermissions[0] });
      let mutations = 0;
      fixture.sf = async (args, options) => {
        if (options?.env || args[0] === 'project' || ['create', 'update', 'delete'].includes(args[1])) {
          mutations += 1;
          throw new Error('Effective grant drift reached a forbidden mutation/login');
        }
        const result = await invoke(args, options);
        const soql = args.includes('--query') ? args[args.indexOf('--query') + 1] : '';
        if (soql.includes("FROM ObjectPermissions WHERE ParentId = '0PSruntime'")) {
          if (scenario === 'incomplete-query') return { ...result, done: false };
          if (scenario === 'missing-records') return {};
        }
        if (scenario === 'incomplete-schema' && args[0] === 'sobject' && args.includes('PermissionSet'))
          return {
            ...result,
            childRelationships: result.childRelationships.filter(child => child.childSObject !== 'FieldPermissions')
          };
        return result;
      };
      for (const command of ['grant-runtime', 'prove', 'use-salesforce-fallback']) {
        await assert.rejects(
          main(
            [
              command,
              ...baseArgs.slice(1),
              '--state-dir',
              directory,
              '--credential-mode',
              'temporary',
              '--pool-mode',
              'definition'
            ],
            fixture
          ),
          /Runtime .*grants|runtime grant inventory|Incomplete Salesforce inventory|preauthorization grant inventory/
        );
        assert.equal(mutations, 0, 'Drift must fail before deployment, assignment, fallback or JWT login');
        assert.deepEqual(
          JSON.parse(readFileSync(stateFile, 'utf8')),
          state,
          'Rejected drift preserves recorded ownership and grants'
        );
      }
    });
  }
});

test('runtime commands reject unknown object, field, Apex and custom grants even with every admin flag false', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, state);
  state.integrationFailure = { license: 'integration', licenseRestriction: true, affectedObjects: ['ScratchOrgInfo'] };
  writeFileSync(stateFile, JSON.stringify(state));
  const allowed = structuredClone(fixture.records.PermissionSetAssignment);
  const invoke = fixture.sf;
  let mutations = 0;
  fixture.sf = async (args, options) => {
    if (options?.env || args[0] === 'project' || ['create', 'update', 'delete'].includes(args[1])) {
      mutations += 1;
      throw new Error('Runtime drift reached a forbidden mutation/login');
    }
    return invoke(args, options);
  };
  for (const extra of [
    { ObjectPermissions: [{ SobjectType: 'Account', PermissionsRead: true }] },
    { FieldPermissions: [{ Field: 'Account.Name', PermissionsRead: true }] },
    { SetupEntityAccess: [{ SetupEntityType: 'ApexClass', SetupEntityId: 'extra-class' }] },
    { SetupEntityAccess: [{ SetupEntityType: 'CustomPermission', SetupEntityId: 'extra-custom' }] }
  ]) {
    const assignment = {
      Id: 'unexpected-assignment',
      AssigneeId: '005runtime',
      PermissionSetId: 'unexpected-set',
      PermissionSetGroupId: null,
      PermissionSet: {
        Name: 'UnrelatedDataAccess',
        ...Object.fromEntries(ADMINISTRATIVE_PERMISSIONS.map(name => [name, false])),
        ...extra
      }
    };
    fixture.records.PermissionSetAssignment = [...allowed, assignment];
    for (const command of ['grant-runtime', 'prove', 'use-salesforce-fallback']) {
      await assert.rejects(
        main(
          [
            command,
            ...baseArgs.slice(1),
            '--state-dir',
            directory,
            '--credential-mode',
            'temporary',
            '--pool-mode',
            'definition'
          ],
          fixture
        ),
        /Unrecognized or unverified runtime permission-set assignment/
      );
      assert.equal(mutations, 0);
      assert.ok(fixture.records.PermissionSetAssignment.includes(assignment), 'Unrelated access must be preserved');
    }
  }
});

test('runtime assignment validation preserves initial setup before ECA and the legitimate owned ECA binding', async t => {
  for (const withApp of [false, true]) {
    let fixture, directory;
    if (withApp) ({ fixture, directory } = await preparedAppFixture(t));
    else {
      fixture = provisioningFixture();
      directory = stateDirectory(t);
      await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
      fixture.records.PermissionSetAssignment = [];
    }
    const stateFile = path.join(directory, 'identity.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    addRuntimeAssignment(fixture, state);
    if (!withApp) {
      fixture.records.PermissionSetAssignment = [];
      delete state.runtime;
      delete state.runtimeAssignmentId;
    }
    addProfileAssignment(fixture);
    writeFileSync(stateFile, JSON.stringify(state));
    addRuntimeGrantInventory(fixture);
    const args = ['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory];
    const first = await main(args, fixture);
    assert.equal(first.status, 'runtime-ready');
    assert.equal(first.permissionSetId, '0PSruntime');
    const assignments = structuredClone(fixture.records.PermissionSetAssignment);
    assert.equal(assignments.length, withApp ? 3 : 2);
    const second = await main(args, fixture);
    assert.equal(second.status, 'runtime-ready');
    assert.deepEqual(
      fixture.records.PermissionSetAssignment,
      assignments,
      'Legitimate rerun must not duplicate assignments'
    );
    if (withApp) assert.equal(fixture.records.SetupEntityAccess[0].SetupEntityId, state.apps.temporary.id);
    else assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).apps, undefined);
  }
});

test('runtime commands fail closed on missing inventory, mismatched identity and unverified assignments', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, baseline);
  const allowed = structuredClone(fixture.records.PermissionSetAssignment);
  const invoke = fixture.sf;
  for (const scenario of [
    'missing-records',
    'incomplete-query',
    'missing-runtime',
    'wrong-assignee',
    'wrong-set-id',
    'group-assignment',
    'duplicate',
    'changed-recorded-id',
    'changed-app-owner',
    'missing-set',
    'incomplete-set',
    'foreign-profile'
  ]) {
    const state = structuredClone(baseline);
    fixture.records.PermissionSetAssignment = structuredClone(allowed);
    const assignment = fixture.records.PermissionSetAssignment.at(-1);
    if (scenario === 'missing-runtime') fixture.records.PermissionSetAssignment.pop();
    if (scenario === 'wrong-assignee') assignment.AssigneeId = 'other-user';
    if (scenario === 'wrong-set-id') {
      assignment.PermissionSet = { ...fixture.records.PermissionSet.at(-1) };
      assignment.PermissionSetId = 'unrecognized-id';
    }
    if (scenario === 'group-assignment') assignment.PermissionSetGroupId = 'group-id';
    if (scenario === 'duplicate') fixture.records.PermissionSetAssignment.push({ ...assignment });
    if (scenario === 'changed-recorded-id') state.runtime.permissionSetId = 'different-recorded-id';
    if (scenario === 'changed-app-owner') state.apps.temporary.marker = 'another-owner';
    if (scenario === 'foreign-profile')
      assignment.PermissionSet = {
        ...fixture.records.PermissionSet.at(-1),
        Name: 'OtherProfileSet',
        IsOwnedByProfile: true,
        ProfileId: 'other-profile'
      };
    writeFileSync(stateFile, JSON.stringify(state));
    let mutations = 0;
    fixture.sf = async (args, options) => {
      if (options?.env || args[0] === 'project' || ['create', 'update', 'delete'].includes(args[1])) {
        mutations += 1;
        throw new Error('Unverified inventory reached a mutation');
      }
      const result = await invoke(args, options);
      const soql = args.includes('--query') ? args[args.indexOf('--query') + 1] : '';
      if (soql.includes(' FROM PermissionSetAssignment ')) {
        if (scenario === 'missing-records') return {};
        if (scenario === 'incomplete-query') return { ...result, done: false };
      }
      if (soql.includes("WHERE Name = 'ALV_ScratchOrgPoolService'")) {
        if (scenario === 'missing-set') return { records: [], done: true, totalSize: 0 };
        if (scenario === 'incomplete-set') return { ...result, done: false };
      }
      return result;
    };
    for (const command of scenario === 'missing-runtime' ? ['prove'] : ['grant-runtime', 'prove']) {
      await assert.rejects(
        main(
          [
            command,
            ...baseArgs.slice(1),
            '--state-dir',
            directory,
            '--credential-mode',
            'temporary',
            '--pool-mode',
            'definition'
          ],
          fixture
        ),
        /Unrecognized or unverified runtime|Incomplete Salesforce inventory|Verified runtime permission-set assignment is missing/
      );
      assert.equal(mutations, 0);
    }
  }
});

test('app setup validates before deployment, preauthorizes only the owned user, and resumes without another identity or app', async t => {
  const { fixture, args, first, deployments } = await preparedAppFixture(t);
  assert.equal(first.status, 'app-ready');
  assert.equal(first.mode, 'temporary');
  assert.equal(fixture.records.PermissionSetAssignment[0].AssigneeId, '005runtime');
  assert.doesNotMatch(JSON.stringify(first), /fixture-consumer-secret|fixture-client-key|BEGIN .*PRIVATE KEY/);
  const previousDeployments = deployments();
  const second = await main(args, fixture);
  assert.equal(second.name, first.name);
  assert.equal(deployments(), previousDeployments);
  assert.equal(fixture.records.ExternalClientApplication.length, 1);
  assert.equal(fixture.records.PermissionSetAssignment.length, 1);
});

test('native proof rejects ECA policy drift after provisioning before JWT login or resource mutation', async t => {
  const { fixture, directory, first } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, state);
  writeFileSync(stateFile, JSON.stringify(state));
  const persisted = readFileSync(stateFile);
  const invoke = fixture.sf;
  const files = {
    global: `extlClntAppGlobalOauthSets/${first.name}_global.ecaGlblOauth-meta.xml`,
    oauth: `extlClntAppOauthSettings/${first.name}_oauth.ecaOauth-meta.xml`,
    policy: `extlClntAppOauthPolicies/${first.name}_oauthPlcy.ecaOauthPlcy-meta.xml`,
    app: `extlClntAppPolicies/${first.name}_plcy.ecaPlcy-meta.xml`
  };
  const privateInputs = readFileSync(state.apps.temporary.inputsFile);
  const privateKey = readFileSync(state.apps.temporary.privateKeyFile);
  for (const [component, field, replacement] of [
    ['policy', 'isClientCredentialsFlowEnabled', 'true'],
    ['policy', 'isGuestCodeCredFlowEnabled', null],
    ['policy', 'isTokenExchangeFlowEnabled', 'true'],
    ['global', 'isPkceRequired', 'false'],
    ['global', 'isSecretRequiredForRefreshToken', null],
    ['global', 'isConsumerSecretOptional', 'true'],
    ['global', 'isIntrospectAllTokens', 'true'],
    ['global', 'shouldRotateConsumerKey', 'true'],
    ['global', 'shouldRotateConsumerSecret', 'true'],
    ['global', 'callbackUrl', 'https://another.example.test'],
    ['oauth', 'commaSeparatedOauthScopes', 'Api,RefreshToken,Full'],
    ['policy', 'ipRelaxationPolicyType', 'Relax'],
    ['policy', 'refreshTokenPolicyType', 'Infinite'],
    ['policy', 'sessionTimeoutInMinutes', '60'],
    ['policy', 'permittedUsersPolicyType', 'AllUsersMaySelfAuthorize'],
    ['policy', 'commaSeparatedPermissionSet', 'AnotherSet'],
    ['app', 'isEnabled', 'false'],
    ['app', 'isOauthPluginEnabled', 'false'],
    ['global', 'consumerKey', 'different-client-key'],
    ['global', 'certificate', 'invalid-certificate'],
    ['retrieval', 'partial', null],
    ['retrieval', 'no-files', null],
    ['retrieval', 'failure', null]
  ]) {
    await t.test(`${component}:${field}`, async () => {
      writeFileSync(stateFile, persisted);
      let loginOrMutations = 0;
      fixture.sf = async (args, options) => {
        if (options?.env || ['create', 'update', 'delete', 'deploy'].includes(args[1])) {
          loginOrMutations++;
          throw new Error('Changed ECA policy reached login or mutation');
        }
        const retrieval = args[0] === 'project' && args[1] === 'retrieve';
        if (retrieval && component === 'retrieval' && field !== 'partial') return { success: field === 'no-files' };
        const result = await invoke(args, options);
        if (retrieval) {
          if (component === 'retrieval') {
            rmSync(path.join(options.cwd, 'force-app', 'main', 'default', files.oauth));
          } else {
            const file = path.join(options.cwd, 'force-app', 'main', 'default', files[component]);
            writeFileSync(
              file,
              readFileSync(file, 'utf8').replace(
                new RegExp(`<${field}>[\\s\\S]*?</${field}>`),
                replacement === null ? '' : `<${field}>${replacement}</${field}>`
              )
            );
          }
        }
        return result;
      };
      await assert.rejects(
        main(
          [
            'prove',
            ...baseArgs.slice(1),
            '--state-dir',
            directory,
            '--credential-mode',
            'temporary',
            '--pool-mode',
            'definition'
          ],
          fixture
        ),
        /Effective ECA|active ECA certificate|metadata retrieval failed|metadata inventory is incomplete|ENOENT/
      );
      assert.equal(loginOrMutations, 0);
      assert.ok(readFileSync(stateFile).equals(persisted), 'Rejected app drift preserves proof and identity state');
      assert.ok(readFileSync(state.apps.temporary.inputsFile).equals(privateInputs), 'Private inputs are preserved');
      assert.ok(readFileSync(state.apps.temporary.privateKeyFile).equals(privateKey), 'Private key is preserved');
    });
  }
});

test('native proof requires a complete sole-user ECA preauthorization inventory', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, state);
  writeFileSync(stateFile, JSON.stringify(state));
  const persisted = readFileSync(stateFile);
  const assignment = structuredClone(fixture.records.PermissionSetAssignment[0]);
  const invoke = fixture.sf;
  for (const scenario of [
    'another-user',
    'missing',
    'duplicate',
    'wrong-set',
    'wrong-id',
    'group',
    'missing-assignee',
    'missing-records',
    'incomplete',
    'missing-completion',
    'missing-total',
    'truncated',
    'app-missing',
    'app-duplicate',
    'app-id',
    'app-name',
    'app-owner',
    'app-contact',
    'app-incomplete'
  ]) {
    await t.test(scenario, async () => {
      writeFileSync(stateFile, persisted);
      let loginOrMutations = 0;
      fixture.sf = async (args, options) => {
        if (options?.env || ['create', 'update', 'delete', 'deploy'].includes(args[1])) {
          loginOrMutations++;
          throw new Error('Unverified ECA recipients reached login or mutation');
        }
        const soql = args.includes('--query') ? args[args.indexOf('--query') + 1] : '';
        if (scenario.startsWith('app-') && soql.includes('FROM ExternalClientApplication WHERE DeveloperName =')) {
          const records = structuredClone(fixture.records.ExternalClientApplication);
          if (scenario === 'app-missing') records.length = 0;
          if (scenario === 'app-duplicate') records.push({ ...records[0] });
          if (scenario === 'app-id') records[0].Id = 'another-app';
          if (scenario === 'app-name') records[0].DeveloperName = 'AnotherApp';
          if (scenario === 'app-owner') records[0].Description = 'another-owner';
          if (scenario === 'app-contact') delete records[0].ContactEmail;
          return { records, done: scenario !== 'app-incomplete' };
        }
        if (soql.includes("FROM PermissionSetAssignment WHERE PermissionSetId = '0PSaccess'")) {
          const records = [{ ...assignment }];
          if (scenario === 'another-user')
            records.push({ ...assignment, Id: 'other-assignment', AssigneeId: 'another-user' });
          if (scenario === 'missing') records.length = 0;
          if (scenario === 'duplicate') records.push({ ...assignment });
          if (scenario === 'wrong-set') records[0].PermissionSetId = 'other-set';
          if (scenario === 'wrong-id') records[0].Id = 'other-assignment';
          if (scenario === 'group') records[0].PermissionSetGroupId = 'other-group';
          if (scenario === 'missing-assignee') delete records[0].AssigneeId;
          if (scenario === 'missing-records') return {};
          const result = { records, done: scenario !== 'incomplete', totalSize: records.length };
          if (scenario === 'missing-completion') delete result.done;
          if (scenario === 'missing-total') delete result.totalSize;
          if (scenario === 'truncated') result.totalSize = 2;
          return result;
        }
        return invoke(args, options);
      };
      await assert.rejects(
        main(
          [
            'prove',
            ...baseArgs.slice(1),
            '--state-dir',
            directory,
            '--credential-mode',
            'temporary',
            '--pool-mode',
            'definition'
          ],
          fixture
        ),
        /ECA preauthorization assignment|Owned ECA identity|Incomplete Salesforce inventory/
      );
      assert.equal(loginOrMutations, 0);
      assert.ok(readFileSync(stateFile).equals(persisted), 'Rejected ECA inventory preserves identity state');
      assert.deepEqual(
        fixture.records.PermissionSetAssignment[0],
        assignment,
        'Do not alter recipients to pass an audit'
      );
    });
  }
});

test('app setup rejects every extra preauthorization grant before assignment and on a configured rerun', async t => {
  const { fixture, args, deployments } = await preparedAppFixture(t);
  const initialDeployments = deployments();
  const permission = fixture.records.PermissionSet[0];
  const validEntity = structuredClone(fixture.records.SetupEntityAccess);
  const initialAssignments = structuredClone(fixture.records.PermissionSetAssignment);
  for (const assigned of [false, true]) {
    fixture.records.PermissionSetAssignment = assigned ? structuredClone(initialAssignments) : [];
    for (const [object, extra] of [
      ['ObjectPermissions', { Id: 'account-read', SobjectType: 'Account', PermissionsRead: true }],
      ['FieldPermissions', { Id: 'account-field', Field: 'Account.Name', PermissionsRead: true }],
      ['SetupEntityAccess', { SetupEntityId: 'unrelated-class', SetupEntityType: 'ApexClass' }],
      ['SetupEntityAccess', { SetupEntityId: 'unrelated-custom', SetupEntityType: 'CustomPermission' }],
      ['SetupEntityAccess', { SetupEntityId: 'unrelated-app', SetupEntityType: 'ExternalClientApplication' }],
      ['PermissionSetTabSetting', { Id: 'extra-tab' }],
      ['PermissionSetGroupComponent', { Id: 'group-membership' }]
    ]) {
      fixture.records[object] = object === 'SetupEntityAccess' ? [...validEntity, extra] : [extra];
      await assert.rejects(main(args, fixture), /preauthorization.*grant/i);
      assert.equal(fixture.records.PermissionSetAssignment.length, assigned ? 1 : 0);
      assert.ok(fixture.records[object].includes(extra), 'The command must not remove drifted grants');
      fixture.records[object] = object === 'SetupEntityAccess' ? structuredClone(validEntity) : [];
    }
    for (const value of [true, undefined]) {
      permission.PermissionsApiEnabled = value;
      await assert.rejects(main(args, fixture), /preauthorization.*grant/i);
      assert.equal(fixture.records.PermissionSetAssignment.length, assigned ? 1 : 0);
    }
    permission.PermissionsApiEnabled = false;
  }
  fixture.records.SetupEntityAccess = [];
  await assert.rejects(main(args, fixture), /preauthorization.*grant/i);
  fixture.records.SetupEntityAccess = [
    { SetupEntityId: 'unrelated-app', SetupEntityType: 'ExternalClientApplication' }
  ];
  await assert.rejects(main(args, fixture), /preauthorization.*grant/i);
  fixture.records.SetupEntityAccess = validEntity;
  const result = await main(args, fixture);
  assert.equal(result.status, 'app-ready');
  assert.equal(deployments(), initialDeployments);
});
