const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const { main } = require('./devhub-identity');
const { ADMINISTRATIVE_PERMISSIONS } = require('./devhub-identity-permissions');

const baseArgs = ['inspect', '--target-org', 'Bootstrap', '--expected-org-id', '00D000000000001AAA'];

test('provisioning refuses an unexpected target before any mutation', async () => {
  const sf = async args => {
    assert.equal(args.slice(0, 3).join(' '), 'data query --target-org');
    return { records: [{ Id: '00D000000000002AAA', IsSandbox: false }] };
  };
  await assert.rejects(main(baseArgs, { sf }), /Target org does not match/);
});

function discoveryFixture() {
  const records = {
    Organization: [{ Id: '00D000000000001AAA', IsSandbox: false }],
    UserLicense: [
      { Id: '100integration', Name: 'Salesforce Integration', TotalLicenses: 5, UsedLicenses: 0 },
      { Id: '100salesforce', Name: 'Salesforce', TotalLicenses: 10, UsedLicenses: 2 }
    ],
    Profile: [
      {
        Id: '00eintegration',
        Name: 'Minimum Access - API Only Integrations',
        UserLicenseId: '100integration',
        PermissionsApiEnabled: true,
        PermissionsApiUserOnly: true,
        PermissionsModifyAllData: false,
        PermissionsModifyMetadata: false,
        PermissionsManageUsers: false
      },
      {
        Id: '00esalesforce',
        Name: 'Minimum Access - Salesforce',
        UserLicenseId: '100salesforce',
        PermissionsApiEnabled: false,
        PermissionsApiUserOnly: false,
        PermissionsModifyAllData: false,
        PermissionsModifyMetadata: false,
        PermissionsManageUsers: false
      }
    ],
    PermissionSetLicense: [
      {
        Id: '0PLintegration',
        DeveloperName: 'SalesforceAPIIntegrationPsl',
        MasterLabel: 'Salesforce API Integration',
        TotalLicenses: 5,
        UsedLicenses: 0
      }
    ],
    User: [],
    ExternalClientApplication: [],
    PermissionSet: [],
    ActiveScratchOrg: [{ Id: 'other-scratch', OwnerId: 'other-user', ScratchOrgInfoId: 'other-signup' }],
    ALV_ScratchOrgPool__c: [
      { Id: 'shared-pool', PoolKey__c: 'production', ProvisioningMode__c: 'snapshot', TargetSize__c: 2 }
    ]
  };
  for (const profile of records.Profile) {
    Object.assign(profile, {
      PermissionsCustomizeApplication: false,
      PermissionsAuthorApex: false,
      PermissionsManageProfilesPermissionsets: false,
      PermissionsManageRoles: false,
      PermissionsViewAllData: false
    });
  }
  const sf = async args => {
    assert.equal(args[0], 'data');
    assert.equal(args[1], 'query', 'inspect must remain read-only');
    const soql = args[args.indexOf('--query') + 1];
    const object = soql.match(/ FROM (\w+)/)[1];
    assert.ok(records[object], `Unrecognized Salesforce query: ${object}`);
    let result = records[object];
    const namedPermission = object === 'PermissionSet' && soql.match(/WHERE Name = '([^']+)'/);
    if (namedPermission) result = result.filter(item => item.Name === namedPermission[1]);
    const profilePermission = object === 'PermissionSet' && soql.match(/WHERE ProfileId = '([^']+)'/);
    if (profilePermission) result = result.filter(item => item.ProfileId === profilePermission[1]);
    const assignedSet = object === 'PermissionSetAssignment' && soql.match(/WHERE PermissionSetId = '([^']+)'/);
    if (assignedSet) result = result.filter(item => item.PermissionSetId === assignedSet[1]);
    if (object === 'PermissionSetAssignment' && soql.includes('PermissionSet.')) {
      result = result.map(item => ({
        ...item,
        PermissionSet: item.PermissionSet || records.PermissionSet.find(set => set.Id === item.PermissionSetId)
      }));
    }
    return { records: result, done: true, totalSize: result.length };
  };
  return { records, sf };
}

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

function stateDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'alv-identity-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

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

function provisioningFixture() {
  const fixture = discoveryFixture();
  fixture.records.PermissionSetLicenseAssign = [];
  const read = fixture.sf;
  const created = [];
  fixture.sf = async args => {
    if (args[0] === 'data' && args[1] === 'query') return read(args);
    assert.equal(args.slice(0, 3).join(' '), 'data create record');
    const object = args[args.indexOf('--sobject') + 1];
    const fields = Object.fromEntries(
      require('shell-quote')
        .parse(args[args.indexOf('--values') + 1])
        .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)])
    );
    const id = object === 'User' ? '005runtime' : '2LApsl';
    const record = { Id: id, ...fields };
    if (object === 'PermissionSetAssignment') record.PermissionSetGroupId = null;
    if (object === 'User') record.IsActive = fields.IsActive === 'true';
    fixture.records[object].push(record);
    created.push({ object, record });
    return { id, success: true };
  };
  return { ...fixture, created };
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

async function temporaryCertificate(t) {
  const directory = stateDirectory(t);
  const openssl = [
    'openssl',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
    path.join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'openssl.exe')
  ].find(
    candidate =>
      require('cross-spawn').sync(candidate, ['version'], { encoding: 'utf8', windowsHide: true }).status === 0
  );
  assert.ok(openssl, 'OpenSSL is required for certificate interoperability tests; provide it through PATH.');
  return main(
    [
      'create-certificate',
      '--state-dir',
      directory,
      '--credential-mode',
      'temporary',
      '--certificate-days',
      '2',
      '--storage-policy',
      'temporary-local',
      '--openssl',
      openssl
    ],
    { sf: async () => assert.fail('Certificate generation is local') }
  );
}

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

async function preparedAppFixture(t) {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  const certificate = await temporaryCertificate(t);
  fixture.records.PermissionSetAssignment = [];
  fixture.permissionFields = ['PermissionsApiEnabled', ...ADMINISTRATIVE_PERMISSIONS];
  fixture.permissionChildren = [
    ['ObjectPermissions', 'ParentId'],
    ['FieldPermissions', 'ParentId'],
    ['SetupEntityAccess', 'ParentId'],
    ['PermissionSetTabSetting', 'ParentId'],
    ['PermissionSetGroupComponent', 'PermissionSetId'],
    ['PermissionSetAssignment', 'PermissionSetId'],
    ['SessionPermSetActivation', 'PermissionSetId']
  ];
  for (const [object] of fixture.permissionChildren) fixture.records[object] ||= [];
  const invoke = fixture.sf;
  const validated = new Set();
  let deployments = 0;
  fixture.sf = async (args, options) => {
    if (args[0] === 'sobject' && args[1] === 'describe') {
      assert.equal(args[args.indexOf('--sobject') + 1], 'PermissionSet');
      return {
        fields: fixture.permissionFields.map(name => ({ name, type: 'boolean' })),
        childRelationships: fixture.permissionChildren.map(([childSObject, field]) => ({ childSObject, field }))
      };
    }
    if (args[0] !== 'project') return invoke(args);
    const app = JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8')).apps.temporary;
    if (args[1] === 'deploy') {
      if (args.includes('--dry-run')) {
        validated.add(options.cwd);
        return { success: true, status: 'Succeeded', checkOnly: true, id: '0Afcheck' };
      }
      assert.ok(validated.has(options.cwd), 'Every deployed stage must have passed validation');
      deployments += 1;
      if (path.basename(options.cwd) === 'base') {
        fixture.records.ExternalClientApplication.push({
          Id: '0xIruntime',
          DeveloperName: app.name,
          Description: app.marker,
          ContactEmail: 'apex-log-viewer-ci@electivus.com'
        });
        fixture.records.PermissionSet.push({
          Id: '0PSaccess',
          Name: app.preauthorization,
          Description: app.marker,
          IsOwnedByProfile: false,
          HasActivationRequired: false,
          LicenseId: null,
          Type: 'Regular',
          ...Object.fromEntries(fixture.permissionFields.map(name => [name, false]))
        });
      }
      if (path.basename(options.cwd) === 'policy') {
        fixture.records.SetupEntityAccess = [{ SetupEntityId: app.id, SetupEntityType: 'ExternalClientApplication' }];
      }
      return { success: true, status: 'Succeeded', checkOnly: false, id: '0Afdeploy' };
    }
    assert.equal(args[1], 'retrieve');
    const project = JSON.parse(readFileSync(path.join(options.cwd, 'sfdx-project.json'), 'utf8'));
    for (const entry of project.packageDirectories) {
      assert.ok(
        existsSync(path.join(options.cwd, entry.path)),
        'Salesforce CLI requires every package directory before retrieval'
      );
    }
    const files = {
      [`extlClntAppGlobalOauthSets/${app.name}_global.ecaGlblOauth-meta.xml`]: `<ExtlClntAppGlobalOauthSettings><consumerKey>fixture-client-key</consumerKey><consumerSecret>fixture-consumer-secret</consumerSecret><certificate>${readFileSync(certificate.certificateFile, 'utf8')}</certificate><callbackUrl>http://localhost:1717/OauthRedirect</callbackUrl><isConsumerSecretOptional>false</isConsumerSecretOptional><isIntrospectAllTokens>false</isIntrospectAllTokens><isPkceRequired>true</isPkceRequired><isSecretRequiredForRefreshToken>true</isSecretRequiredForRefreshToken><shouldRotateConsumerKey>false</shouldRotateConsumerKey><shouldRotateConsumerSecret>false</shouldRotateConsumerSecret></ExtlClntAppGlobalOauthSettings>`,
      [`extlClntAppOauthSettings/${app.name}_oauth.ecaOauth-meta.xml`]:
        '<ExtlClntAppOauthSettings><commaSeparatedOauthScopes>Api,RefreshToken</commaSeparatedOauthScopes></ExtlClntAppOauthSettings>',
      [`extlClntAppOauthPolicies/${app.name}_oauthPlcy.ecaOauthPlcy-meta.xml`]: `<ExtlClntAppOauthConfigurablePolicies><commaSeparatedPermissionSet>${app.preauthorization}</commaSeparatedPermissionSet><ipRelaxationPolicyType>Enforce</ipRelaxationPolicyType><permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType><refreshTokenPolicyType>Zero</refreshTokenPolicyType><sessionTimeoutInMinutes>15</sessionTimeoutInMinutes><isClientCredentialsFlowEnabled>false</isClientCredentialsFlowEnabled><isGuestCodeCredFlowEnabled>false</isGuestCodeCredFlowEnabled><isTokenExchangeFlowEnabled>false</isTokenExchangeFlowEnabled></ExtlClntAppOauthConfigurablePolicies>`,
      [`extlClntAppPolicies/${app.name}_plcy.ecaPlcy-meta.xml`]:
        '<ExtlClntAppConfigurablePolicies><isEnabled>true</isEnabled><isOauthPluginEnabled>true</isOauthPluginEnabled></ExtlClntAppConfigurablePolicies>'
    };
    for (const [relative, body] of Object.entries(files)) {
      const file = path.join(options.cwd, 'force-app', 'main', 'default', relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    return { success: true, status: 'Succeeded' };
  };
  const args = [
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
  ];
  const first = await main(args, fixture);
  return { fixture, directory, args, first, deployments: () => deployments };
}

function addRuntimeAssignment(fixture, state) {
  const permission = {
    Id: '0PSruntime',
    Name: 'ALV_ScratchOrgPoolService',
    IsOwnedByProfile: false,
    Type: 'Regular',
    NamespacePrefix: null,
    ...Object.fromEntries(ADMINISTRATIVE_PERMISSIONS.map(name => [name, false]))
  };
  fixture.records.PermissionSet.push(permission);
  fixture.records.PermissionSetAssignment.push({
    Id: 'runtime-assignment',
    AssigneeId: '005runtime',
    PermissionSetId: permission.Id,
    PermissionSetGroupId: null
  });
  state.runtime = { permissionSetId: permission.Id };
  state.runtimeAssignmentId = 'runtime-assignment';
  addRuntimeGrantInventory(fixture);
  return permission;
}

function addRuntimeGrantInventory(fixture) {
  if (fixture.runtimeGrants) return fixture.runtimeGrants;
  fixture.permissionFields ||= ['PermissionsApiEnabled', ...ADMINISTRATIVE_PERMISSIONS];
  fixture.permissionChildren ||= [
    ['ObjectPermissions', 'ParentId'],
    ['FieldPermissions', 'ParentId'],
    ['SetupEntityAccess', 'ParentId'],
    ['PermissionSetTabSetting', 'ParentId'],
    ['PermissionSetGroupComponent', 'PermissionSetId'],
    ['PermissionSetAssignment', 'PermissionSetId'],
    ['SessionPermSetActivation', 'PermissionSetId']
  ];
  const permission = fixture.records.PermissionSet.find(item => item.Id === '0PSruntime');
  Object.assign(permission, {
    HasActivationRequired: false,
    LicenseId: null,
    ...Object.fromEntries(fixture.permissionFields.map(name => [name, name === 'PermissionsApiEnabled']))
  });
  const { xmlValue } = require('./devhub-identity-app');
  const source = readFileSync(
    path.join(
      __dirname,
      '..',
      'force-app',
      'main',
      'default',
      'permissionsets',
      'ALV_ScratchOrgPoolService.permissionset-meta.xml'
    ),
    'utf8'
  );
  const permissionNames = {
    allowRead: 'PermissionsRead',
    allowCreate: 'PermissionsCreate',
    allowEdit: 'PermissionsEdit',
    allowDelete: 'PermissionsDelete',
    viewAllRecords: 'PermissionsViewAllRecords',
    modifyAllRecords: 'PermissionsModifyAllRecords'
  };
  const objects = [...source.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g)].map(([, body]) => ({
    ParentId: '0PSruntime',
    SobjectType: xmlValue(body, 'object'),
    PermissionsViewAllFields: false,
    ...Object.fromEntries(Object.entries(permissionNames).map(([xml, api]) => [api, xmlValue(body, xml) === 'true']))
  }));
  const fields = [...source.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g)].map(([, body]) => ({
    ParentId: '0PSruntime',
    Field: xmlValue(body, 'field'),
    PermissionsRead: true,
    PermissionsEdit: true
  }));
  fixture.records.ApexClass = [
    { Id: 'rest-class', Name: 'ALVScratchPoolRest', NamespacePrefix: null },
    { Id: 'service-class', Name: 'ALVScratchPoolService', NamespacePrefix: null }
  ];
  fixture.runtimeGrants = {
    ObjectPermissions: objects,
    FieldPermissions: fields,
    SetupEntityAccess: fixture.records.ApexClass.map(item => ({
      ParentId: '0PSruntime',
      SetupEntityId: item.Id,
      SetupEntityType: 'ApexClass'
    }))
  };
  const invoke = fixture.sf;
  fixture.sf = async (args, options) => {
    if (args[0] === 'sobject' && args[1] === 'describe') {
      const object = args[args.indexOf('--sobject') + 1];
      if (object === 'PermissionSet')
        return {
          fields: fixture.permissionFields.map(name => ({ name, type: 'boolean' })),
          childRelationships: fixture.permissionChildren.map(([childSObject, field]) => ({ childSObject, field }))
        };
      return {
        fields: (object === 'ObjectPermissions'
          ? [...Object.values(permissionNames), 'PermissionsViewAllFields']
          : ['PermissionsRead', 'PermissionsEdit']
        ).map(name => ({ name, type: 'boolean' }))
      };
    }
    if (args[0] === 'project' && args[1] === 'deploy' && path.basename(options.cwd) === 'runtime-permissions')
      return { success: true, status: 'Succeeded', checkOnly: args.includes('--dry-run'), id: '0Afpermissions' };
    const soql = args.includes('--query') ? args[args.indexOf('--query') + 1] : '';
    if (
      /WHERE (?:ParentId|PermissionSetId) = '0PSruntime'/.test(soql) &&
      !soql.includes('FROM PermissionSetAssignment')
    ) {
      const object = soql.match(/ FROM (\w+)/)[1];
      return {
        records: fixture.runtimeGrants[object] || []
      };
    }
    return invoke(args, options);
  };
  return fixture.runtimeGrants;
}

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
        if (scenario === 'missing-set') return { records: [] };
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

test('app setup refuses an incomplete or unknown preauthorization grant inventory', async t => {
  const { fixture, args } = await preparedAppFixture(t);
  const invoke = fixture.sf;
  fixture.sf = async (command, options) => {
    const result = await invoke(command, options);
    if (
      command[0] === 'data' &&
      command.includes('--query') &&
      command[command.indexOf('--query') + 1].includes(' FROM ObjectPermissions ')
    ) {
      return { ...result, done: false };
    }
    return result;
  };
  await assert.rejects(main(args, fixture), /Incomplete Salesforce inventory/);
  fixture.sf = invoke;
  fixture.permissionChildren.push(['NewGrantCategory', 'ParentId']);
  fixture.records.NewGrantCategory = [{ Id: 'new-grant' }];
  await assert.rejects(main(args, fixture), /preauthorization.*grant/i);
  fixture.permissionChildren = fixture.permissionChildren.filter(([object]) => object !== 'FieldPermissions');
  await assert.rejects(main(args, fixture), /preauthorization.*inventory/i);
});

test('app reruns reject enabled or unverified alternate OAuth flows from effective metadata', async t => {
  const { fixture, directory, args, first, deployments } = await preparedAppFixture(t);
  const invoke = fixture.sf;
  const initialDeployments = deployments();
  for (const flow of ['isClientCredentialsFlowEnabled', 'isGuestCodeCredFlowEnabled', 'isTokenExchangeFlowEnabled']) {
    for (const replacement of [`<${flow}>true</${flow}>`, '']) {
      fixture.sf = async (command, options) => {
        const result = await invoke(command, options);
        if (command[0] === 'project' && command[1] === 'retrieve') {
          const file = path.join(
            directory,
            'app-temporary',
            'retrieved',
            'force-app',
            'main',
            'default',
            'extlClntAppOauthPolicies',
            `${first.name}_oauthPlcy.ecaOauthPlcy-meta.xml`
          );
          writeFileSync(file, readFileSync(file, 'utf8').replace(`<${flow}>false</${flow}>`, replacement));
        }
        return result;
      };
      await assert.rejects(main(args, fixture), /Effective ECA/);
    }
  }
  assert.equal(deployments(), initialDeployments, 'Drift must be reported without silently rewriting active policy');
});

test('app reruns reject changed or missing effective global OAuth controls without redeploying', async t => {
  const { fixture, directory, args, first, deployments } = await preparedAppFixture(t);
  const invoke = fixture.sf;
  const initialDeployments = deployments();
  for (const [field, intended, changed] of [
    ['callbackUrl', 'http://localhost:1717/OauthRedirect', 'https://untrusted.example.test/callback'],
    ['isConsumerSecretOptional', 'false', 'true'],
    ['isIntrospectAllTokens', 'false', 'true'],
    ['isPkceRequired', 'true', 'false'],
    ['isSecretRequiredForRefreshToken', 'true', 'false'],
    ['shouldRotateConsumerKey', 'false', 'true'],
    ['shouldRotateConsumerSecret', 'false', 'true'],
    ['callbackUrl', 'http://localhost:1717/OauthRedirect', undefined]
  ]) {
    fixture.sf = async (command, options) => {
      const result = await invoke(command, options);
      if (command[0] === 'project' && command[1] === 'retrieve') {
        const file = path.join(
          directory,
          'app-temporary',
          'retrieved',
          'force-app',
          'main',
          'default',
          'extlClntAppGlobalOauthSets',
          `${first.name}_global.ecaGlblOauth-meta.xml`
        );
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            `<${field}>${intended}</${field}>`,
            changed === undefined ? '' : `<${field}>${changed}</${field}>`
          )
        );
      }
      return result;
    };
    await assert.rejects(main(args, fixture), /Effective ECA/);
  }
  assert.equal(deployments(), initialDeployments);
});

test('app revocation disables only the owned ECA and confirms the effective policy before recording teardown', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const app = state.apps.temporary;
  const invoke = fixture.sf;
  let disabled = false,
    validated = false;
  fixture.sf = async (args, options) => {
    if (args[0] === 'project') {
      if (args[1] === 'deploy') {
        const file = path.join(
          options.cwd,
          'force-app',
          'main',
          'default',
          'extlClntAppPolicies',
          `${app.name}_plcy.ecaPlcy-meta.xml`
        );
        assert.match(readFileSync(file, 'utf8'), /<isEnabled>false<\/isEnabled>/);
        if (args.includes('--dry-run')) validated = true;
        else {
          assert.ok(validated);
          disabled = true;
        }
        return { success: true, status: 'Succeeded', checkOnly: args.includes('--dry-run'), id: '0Afrevoke' };
      }
      assert.ok(disabled);
      const file = path.join(
        options.cwd,
        'force-app',
        'main',
        'default',
        'extlClntAppPolicies',
        `${app.name}_plcy.ecaPlcy-meta.xml`
      );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        '<ExtlClntAppConfigurablePolicies><isEnabled>false</isEnabled></ExtlClntAppConfigurablePolicies>'
      );
      return { success: true };
    }
    if (args[0] === 'org' && args[1] === 'login')
      throw Object.assign(new Error('invalid_client hidden-token'), { code: 'INVALID_CLIENT' });
    return invoke(args, options);
  };
  const result = await main(
    ['revoke-app', ...baseArgs.slice(1), '--state-dir', directory, '--credential-mode', 'temporary'],
    fixture
  );
  assert.equal(result.status, 'app-disabled');
  assert.equal(result.jwtRejection, 'INVALID_CLIENT');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).apps.temporary.revoked, true);
  assert.equal(fixture.records.User[0].IsActive, true);
  assert.doesNotMatch(JSON.stringify(result), /hidden-token/);
});

test('cleanup-proof rejects an unknown persisted phase even when authenticated inventories are empty', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const id = require('node:crypto').randomUUID();
  state.proof = {
    id,
    appMode: 'temporary',
    phase: 'unknown-after-write',
    remoteResourcesAttempted: true,
    directory: path.join(await realpath(directory), `proof-${id}`),
    poolKey: `alv-identity-${id}`,
    slotKey: `alv-identity-${id}-01`
  };
  writeFileSync(stateFile, JSON.stringify(state));
  const persisted = readFileSync(stateFile);
  const invoke = fixture.sf;
  let reconciliationCalls = 0;
  fixture.sf = async (args, options) => {
    if (!options?.env) return invoke(args, options);
    reconciliationCalls++;
    assert.equal(args.slice(0, 2).join(' '), 'data query');
    return { records: [], done: true };
  };
  await assert.rejects(
    main(['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Unknown or missing proof phase/
  );
  assert.equal(reconciliationCalls, 0, 'Unknown phases must stop before authenticated reconciliation');
  assert.ok(readFileSync(stateFile).equals(persisted), 'Rejected proof phase preserves identity state');
});

test('unknown current and historical phases cannot release proof, revocation or private-cleanup gates', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, baseline);
  const id = require('node:crypto').randomUUID();
  const proof = {
    id,
    appMode: 'temporary',
    phase: 'cleanup',
    remoteResourcesAttempted: true,
    directory: path.join(await realpath(directory), `proof-${id}`),
    poolKey: `alv-identity-${id}`,
    slotKey: `alv-identity-${id}-01`,
    cleanup: { scratchDeleted: true, poolDeleted: true, localDirectoryDeleted: true }
  };
  const privateInputs = readFileSync(baseline.apps.temporary.inputsFile);
  const privateKey = readFileSync(baseline.apps.temporary.privateKeyFile);
  const invoke = fixture.sf;
  let sideEffects = 0;
  fixture.sf = async (args, options) => {
    if (options?.env || args[0] === 'project' || ['create', 'update', 'delete'].includes(args[1])) {
      sideEffects++;
      throw new Error('Unknown phase reached a forbidden operation');
    }
    return invoke(args, options);
  };
  for (const [label, phase, historical] of [
    ['unknown', 'unknown-after-write', false],
    ['absent', undefined, false],
    ['null', null, false],
    ['number', 7, false],
    ['object', {}, false],
    ['historical', 'future-workflow-phase', true]
  ]) {
    await t.test(label, async () => {
      for (const command of ['cleanup-proof', 'prove', 'revoke-app', 'cleanup-app-files']) {
        const state = structuredClone(baseline);
        const unknown = { ...proof, phase };
        state.proof = historical ? { ...proof } : unknown;
        if (historical)
          state.proofHistory = [
            { ...proof, phase: 'login', remoteResourcesAttempted: false, cleanup: undefined },
            unknown
          ];
        state.apps.temporary.revoked = command === 'cleanup-app-files';
        writeFileSync(stateFile, JSON.stringify(state));
        const persisted = readFileSync(stateFile);
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
          /Unknown or missing proof phase/
        );
        assert.equal(sideEffects, 0);
        assert.ok(readFileSync(stateFile).equals(persisted), 'Validate all phases before changing any ledger entry');
        assert.ok(readFileSync(state.apps.temporary.inputsFile).equals(privateInputs), 'Private inputs are preserved');
        assert.ok(readFileSync(state.apps.temporary.privateKeyFile).equals(privateKey), 'Private key is preserved');
      }
    });
  }
});

test('cleanup-proof recovers persisted pre-resource interruptions without directories or authentication', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, baseline);
  const invoke = fixture.sf;
  const proofArgs = [
    'prove',
    ...baseArgs.slice(1),
    '--state-dir',
    directory,
    '--credential-mode',
    'temporary',
    '--pool-mode',
    'definition'
  ];
  for (const [phase, marker, preparedHomes] of [
    ['initializing', false, -1],
    ['initializing', false, 0],
    ['initializing', false, 1],
    ['login', false, 2],
    ['login', undefined, -1],
    ['pool-create', false, 2]
  ]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      phase,
      appMode: 'temporary',
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`,
      ...(marker === undefined ? {} : { remoteResourcesAttempted: marker })
    };
    if (preparedHomes >= 0) mkdirSync(proof.directory);
    for (const home of ['home-a', 'home-b'].slice(0, Math.max(0, preparedHomes)))
      mkdirSync(path.join(proof.directory, home));
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    let runtimeCommands = 0;
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      runtimeCommands += 1;
      throw new Error('No runtime authentication exists at this interrupted boundary');
    };
    const result = await main(['cleanup-proof', ...proofArgs.slice(1)], fixture);
    assert.equal(result.proofs[0].cleanup.scratchDeleted, true);
    assert.equal(result.proofs[0].cleanup.poolDeleted, true);
    assert.equal(result.proofs[0].cleanup.remoteResourcesAttempted, false);
    assert.equal(runtimeCommands, 0, 'Known pre-resource intent needs no authenticated remote inventory');
    // Recovery releases the next proof gate; the fresh attempt reaches login.
    await assert.rejects(main(proofArgs, fixture), /Native proof failed at login/);
    assert.equal(runtimeCommands, 1);
    // Revocation is no longer blocked by a proof that never attempted resources.
    fixture.sf = async (args, options) => {
      if (args[0] === 'project' && args[1] === 'deploy') return { success: false };
      return invoke(args, options);
    };
    await assert.rejects(main(['revoke-app', ...proofArgs.slice(1)], fixture), /Metadata validation failed/);
  }
});

test('proof initialization failures enter recovery before any remote operation', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  addRuntimeAssignment(fixture, state);
  writeFileSync(stateFile, JSON.stringify(state));
  const promises = require('node:fs/promises');
  const mkdir = promises.mkdir;
  const mocked = t.mock.method(promises, 'mkdir', async (target, options) => {
    const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
    if (target === proof?.directory) {
      assert.equal(proof.phase, 'initializing', 'Inject failure only after proof initialization intent is saved');
      throw Object.assign(new Error('Directory unavailable'), { code: 'EACCES' });
    }
    return mkdir(target, options);
  });
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
    /Native proof failed at initializing/
  );
  mocked.mock.restore();
  const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
  assert.equal(proof.remoteResourcesAttempted, false);
  assert.equal(proof.cleanup.scratchDeleted, true);
  assert.equal(proof.cleanup.poolDeleted, true);
});

test('cleanup-proof retains uncertain, attempted, incomplete and conflicting remote state', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  const invoke = fixture.sf;
  for (const [details, scenario, expected] of [
    [{ phase: 'initializing' }, 'missing-auth', /Salesforce CLI operation failed/],
    [{ phase: 'login', remoteResourcesAttempted: true }, 'missing-auth', /Salesforce CLI operation failed/],
    [{ phase: 'pool-create' }, 'missing-auth', /Salesforce CLI operation failed/],
    [
      { phase: 'login', remoteResourcesAttempted: false, poolId: 'uncertain-pool' },
      'missing-auth',
      /Salesforce CLI operation failed/
    ],
    [
      { phase: 'login', remoteResourcesAttempted: false, completedAt: '2026-09-07T00:00:00Z' },
      'missing-auth',
      /Salesforce CLI operation failed/
    ],
    [{ phase: 'pool-create', remoteResourcesAttempted: true }, 'incomplete', /inventory is incomplete/],
    [{ phase: 'scratch-create', remoteResourcesAttempted: true }, 'foreign-owner', /ownership conflict/],
    [{ phase: 'scratch-create', remoteResourcesAttempted: true }, 'pending', /still pending/]
  ]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      appMode: 'temporary',
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`,
      ...details
    };
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    let queries = 0;
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      assert.equal(args.slice(0, 2).join(' '), 'data query', 'Uncertain inventory must never permit deletion');
      queries += 1;
      if (scenario === 'missing-auth') throw new Error('No runtime authentication');
      if (scenario === 'incomplete') return { records: [], done: false };
      return {
        records: [
          { Id: 'signup', CreatedById: scenario === 'foreign-owner' ? 'another-user' : '005runtime', Status: 'New' }
        ]
      };
    };
    await assert.rejects(main(['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory], fixture), expected);
    assert.equal(queries, 1);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).proof.cleanup, undefined);
  }
});

test('cleanup-proof distinguishes confirmed deletion from an unacknowledged delete and preserves retry ownership', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  const invoke = fixture.sf;
  for (const lostDeleteResponse of [false, true]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      appMode: 'temporary',
      phase: 'scratch-create',
      remoteResourcesAttempted: true,
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`
    };
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    let active = true,
      pool = true,
      signupStatus = 'Active',
      failPoolDelete = true;
    const deleted = [];
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      if (args[1] === 'delete') {
        const object = args[args.indexOf('--sobject') + 1];
        const record = args[args.indexOf('--record-id') + 1];
        if (object === 'ActiveScratchOrg') {
          assert.equal(record, 'own-active');
          active = false;
          deleted.push(record);
          if (lostDeleteResponse) throw new Error('Deletion response was lost');
          return { success: true };
        }
        assert.equal(object, 'ALV_ScratchOrgPool__c');
        assert.equal(record, 'own-pool');
        if (failPoolDelete) return { success: false };
        deleted.push(record);
        pool = false;
        return { success: true };
      }
      assert.equal(args.slice(0, 2).join(' '), 'data query');
      const soql = args[args.indexOf('--query') + 1];
      if (soql.includes('FROM ScratchOrgInfo '))
        return { records: [{ Id: 'own-signup', CreatedById: '005runtime', Status: signupStatus }] };
      if (soql.includes('FROM ActiveScratchOrg '))
        return { records: active ? [{ Id: 'own-active', OwnerId: '005runtime', ScratchOrgInfoId: 'own-signup' }] : [] };
      if (soql.includes('FROM ALV_ScratchOrgPool__c '))
        return { records: pool ? [{ Id: 'own-pool', CreatedById: '005runtime' }] : [] };
      return { records: [] };
    };
    const args = ['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory];
    await assert.rejects(
      main(args, fixture),
      lostDeleteResponse ? /Salesforce CLI operation failed/ : /deletion is unconfirmed/
    );
    const pending = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
    assert.equal(pending.cleanup, undefined);
    assert.equal(pending.scratchDeletionReceipts?.length || 0, lostDeleteResponse ? 0 : 1);
    await assert.rejects(
      main(['revoke-app', ...args.slice(1), '--credential-mode', 'temporary'], fixture),
      /Recover the owned scratch/
    );
    failPoolDelete = false;
    if (lostDeleteResponse) {
      await assert.rejects(main(args, fixture), /Active scratch is not yet observable/);
      assert.deepEqual(deleted, ['own-active']);
      signupStatus = 'Deleted';
    }
    const result = await main(args, fixture);
    assert.equal(result.proofs[0].cleanup.scratchDeleted, true);
    assert.equal(result.proofs[0].cleanup.poolDeleted, true);
    assert.deepEqual(deleted, ['own-active', 'own-pool'], 'Resume deletes only remaining owned resources');
  }
});

test('cleanup-proof accepts empty terminal signup cleanup and refuses incomplete or conflicting Active inventory', async t => {
  const { fixture, directory } = await preparedAppFixture(t);
  const stateFile = path.join(directory, 'identity.json');
  const baseline = JSON.parse(readFileSync(stateFile, 'utf8'));
  const invoke = fixture.sf;
  for (const scenario of [
    'Error',
    'Deleted',
    'New',
    'active-empty',
    'active-incomplete',
    'active-foreign-owner',
    'active-wrong-signup',
    'missing-signup-id'
  ]) {
    const id = require('node:crypto').randomUUID();
    const proof = {
      id,
      appMode: 'temporary',
      phase: 'scratch-create',
      remoteResourcesAttempted: true,
      directory: path.join(await realpath(directory), `proof-${id}`),
      poolKey: `alv-identity-${id}`,
      slotKey: `alv-identity-${id}-01`
    };
    writeFileSync(stateFile, JSON.stringify({ ...baseline, proof }));
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      assert.equal(args.slice(0, 2).join(' '), 'data query', 'Unconfirmed inventory must not permit deletion');
      const soql = args[args.indexOf('--query') + 1];
      if (soql.includes('FROM ScratchOrgInfo '))
        return {
          records: [
            {
              ...(scenario === 'missing-signup-id' ? {} : { Id: 'own-signup' }),
              CreatedById: '005runtime',
              Status: ['Error', 'Deleted', 'New'].includes(scenario) ? scenario : 'Active'
            }
          ]
        };
      if (soql.includes('FROM ActiveScratchOrg ')) {
        if (scenario === 'active-incomplete') return { records: [], done: false };
        if (['active-foreign-owner', 'active-wrong-signup'].includes(scenario))
          return {
            records: [
              {
                Id: 'visible-scratch',
                OwnerId: scenario === 'active-foreign-owner' ? 'other-user' : '005runtime',
                ScratchOrgInfoId: scenario === 'active-wrong-signup' ? 'other-signup' : 'own-signup'
              }
            ]
          };
      }
      return { records: [] };
    };
    const args = ['cleanup-proof', ...baseArgs.slice(1), '--state-dir', directory];
    if (['Error', 'Deleted'].includes(scenario))
      assert.equal((await main(args, fixture)).proofs[0].cleanup.scratchDeleted, true);
    else {
      await assert.rejects(
        main(args, fixture),
        /still pending|not yet observable|inventory is incomplete|owner differs/
      );
      assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).proof.cleanup, undefined);
    }
  }
});

for (const scenario of [
  'success',
  'import-failure',
  'redacted-export',
  'cleanup-failure',
  'http-failure',
  'signup-not-visible',
  'active-signup-not-visible',
  'definition-write-failure'
]) {
  test(`native identity proof preserves isolation, lease lifecycle and ownership: ${scenario}`, async t => {
    const { fixture, directory } = await preparedAppFixture(t);
    const stateFile = path.join(directory, 'identity.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    addRuntimeAssignment(fixture, state);
    writeFileSync(stateFile, JSON.stringify(state));
    const invoke = fixture.sf;
    const removed = [];
    let firstHome,
      secondHome,
      ownPool,
      ownSlot,
      signedUp = false,
      active = true,
      scratchVisible = scenario !== 'active-signup-not-visible',
      signupObserved = false;
    const routes = [];
    let maintained = false;
    fixture.sf = async (args, options) => {
      if (!options?.env) return invoke(args, options);
      const env = options.env;
      const command = args.slice(0, 3).join(' ');
      assert.equal(env.SF_DEVHUB_AUTH_URL, undefined);
      if (command !== 'org create scratch') assert.equal(env.SF_SCRATCH_SIGNUP_CONNECTED_APP, undefined);
      if (command !== 'org display --target-org') assert.equal(env.SF_TEMP_SHOW_SECRETS, undefined);
      if (command === 'org login jwt') {
        const intent = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
        assert.equal(intent.phase, 'login');
        assert.equal(intent.remoteResourcesAttempted, false);
        firstHome = env.USERPROFILE;
        assert.deepEqual(require('node:fs').readdirSync(firstHome), []);
        return { orgId: state.org, username: fixture.records.User[0].Username };
      }
      if (command === 'data create record') {
        assert.equal(
          JSON.parse(readFileSync(stateFile, 'utf8')).proof.remoteResourcesAttempted,
          true,
          'Persist uncertainty before the first remote write, including a lost CLI response'
        );
        const object = args[args.indexOf('--sobject') + 1];
        if (object === 'ALV_ScratchOrgPool__c') ownPool = 'own-pool';
        else ownSlot = 'own-slot';
        return { id: object === 'ALV_ScratchOrgPool__c' ? ownPool : ownSlot, success: true };
      }
      if (command === 'api request rest') {
        const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
        const route = args[3].split('/').at(-1);
        routes.push(route);
        const bodyArgument = args[args.indexOf('--body') + 1];
        assert.ok(bodyArgument.startsWith('@'), 'Salesforce CLI 2.150.6 requires @ to read a request body file');
        const payload = JSON.parse(readFileSync(bodyArgument.slice(1), 'utf8'));
        assert.equal(payload.poolKey, proof.poolKey);
        assert.doesNotMatch(args.join(' '), /private-refresh-token|private-lease-token/);
        if (scenario === 'definition-write-failure' && route === 'acquire') {
          mkdirSync(path.join(proof.directory, 'scratch.json'));
        }
        return {
          statusCode: scenario === 'http-failure' ? 503 : 200,
          headers: { 'content-type': 'application/json' },
          body: {
            ok: true,
            poolKey: proof.poolKey,
            slotKey: proof.slotKey,
            leaseToken: 'private-lease-token',
            needsCreate: route === 'acquire',
            provisioningMode: 'definition',
            scratchUsername: 'scratch@example.test',
            leaseState: route === 'release' ? 'available' : 'leased'
          }
        };
      }
      if (command === 'org create scratch') {
        assert.equal(env.USERPROFILE, firstHome);
        assert.equal(env.SF_SCRATCH_SIGNUP_CONNECTED_APP, 'PlatformCLI');
        assert.equal(env.SF_SCRATCH_SIGNUP_CALLBACK_URL, 'http://localhost:1717/OauthRedirect');
        signedUp = true;
        if (['signup-not-visible', 'active-signup-not-visible'].includes(scenario)) {
          signedUp = scenario === 'active-signup-not-visible';
          throw new Error('Lost asynchronous signup response');
        }
        return { orgId: '00D000000000003AAA', username: 'scratch@example.test' };
      }
      if (command === 'org display --target-org') {
        assert.equal(env.SF_TEMP_SHOW_SECRETS, 'true');
        return {
          sfdxAuthUrl:
            scenario === 'redacted-export'
              ? '<REDACTED>'
              : 'force://client::private-refresh-token@scratch.my.salesforce.com'
        };
      }
      if (command === 'org login sfdx-url') {
        secondHome = env.USERPROFILE;
        assert.notEqual(secondHome, firstHome);
        assert.deepEqual(require('node:fs').readdirSync(secondHome), []);
        const auth = readFileSync(args[args.indexOf('--sfdx-url-file') + 1], 'utf8');
        assert.match(auth, /private-refresh-token/);
        if (scenario === 'import-failure') throw new Error('Transport failure containing private-refresh-token');
        return { username: 'scratch@example.test' };
      }
      if (command === 'data update record') {
        maintained = true;
        return { success: true };
      }
      if (command === 'data delete record') {
        const object = args[args.indexOf('--sobject') + 1];
        const id = args[args.indexOf('--record-id') + 1];
        if (scenario === 'cleanup-failure')
          throw Object.assign(new Error('INSUFFICIENT_ACCESS_OR_READONLY private-refresh-token'), {
            code: 'INSUFFICIENT_ACCESS_OR_READONLY'
          });
        removed.push([object, id]);
        if (object === 'ActiveScratchOrg') active = false;
        if (object === 'ALV_ScratchOrgPool__c') ownPool = undefined;
        return { success: true };
      }
      if (args[0] === 'data' && args[1] === 'query') {
        const soql = args[args.indexOf('--query') + 1];
        const target = args[args.indexOf('--target-org') + 1];
        if (soql.includes(' FROM Organization')) {
          if (target === 'alv-runtime')
            throw Object.assign(new Error("sObject type 'Organization' is not supported."), { code: 'INVALID_TYPE' });
          return { records: [{ Id: '00D000000000003AAA' }] };
        }
        if (soql.includes(' FROM User ')) return { records: fixture.records.User };
        if (soql.includes(' FROM ScratchOrgInfo ')) {
          signupObserved = true;
          return { records: signedUp ? [{ Id: 'own-signup', CreatedById: '005runtime', Status: 'Active' }] : [] };
        }
        if (soql.includes(' FROM ActiveScratchOrg ')) {
          assert.ok(signupObserved, 'Reconcile the scratch ownership marker before deletion');
          return {
            records:
              active && scratchVisible
                ? [{ Id: 'own-scratch', OwnerId: '005runtime', ScratchOrgInfoId: 'own-signup' }]
                : []
          };
        }
        if (soql.includes(' FROM ALV_ScratchOrgPool__c '))
          return { records: ownPool ? [{ Id: ownPool, CreatedById: '005runtime' }] : [] };
        if (soql.includes(' FROM ALV_ScratchOrgPoolSlot__c ')) {
          if (soql.includes(' WHERE Id = '))
            return {
              records: [{ Id: ownSlot, LeaseState__c: maintained ? 'disabled' : 'leased', ScratchAuthUrl__c: null }]
            };
          const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
          return { records: [{ Id: ownSlot, CreatedById: '005runtime', SlotKey__c: proof.slotKey }] };
        }
      }
      assert.fail(`Unexpected native proof command: ${command}`);
    };
    const args = [
      'prove',
      ...baseArgs.slice(1),
      '--state-dir',
      directory,
      '--credential-mode',
      'temporary',
      '--pool-mode',
      'definition'
    ];
    if (scenario === 'success') {
      const result = await main(args, fixture);
      assert.equal(result.status, 'proof-passed');
      assert.doesNotMatch(JSON.stringify(result), /private-refresh-token|private-lease-token/);
      assert.deepEqual(routes, ['acquire', 'finalize', 'heartbeat', 'release']);
    } else {
      await assert.rejects(main(args, fixture), error => {
        assert.match(
          error.message,
          ['cleanup-failure', 'signup-not-visible', 'active-signup-not-visible'].includes(scenario)
            ? /cleanup\/recovery/
            : scenario === 'http-failure'
              ? /pool-acquire/
              : scenario === 'definition-write-failure'
                ? /scratch-prepare/
                : /scratch-export-import/
        );
        assert.doesNotMatch(error.message, /private-refresh-token|private-lease-token/);
        return true;
      });
    }
    assert.ok(firstHome);
    assert.equal(
      Boolean(secondHome),
      ![
        'redacted-export',
        'http-failure',
        'signup-not-visible',
        'active-signup-not-visible',
        'definition-write-failure'
      ].includes(scenario)
    );
    assert.deepEqual(
      removed,
      ['cleanup-failure', 'signup-not-visible', 'active-signup-not-visible'].includes(scenario)
        ? []
        : ['http-failure', 'definition-write-failure'].includes(scenario)
          ? [
              ['ALV_ScratchOrgPoolSlot__c', 'own-slot'],
              ['ALV_ScratchOrgPool__c', 'own-pool']
            ]
          : [
              ['ActiveScratchOrg', 'own-scratch'],
              ['ALV_ScratchOrgPoolSlot__c', 'own-slot'],
              ['ALV_ScratchOrgPool__c', 'own-pool']
            ]
    );
    assert.equal(fixture.records.ActiveScratchOrg[0].Id, 'other-scratch');
    assert.equal(fixture.records.ALV_ScratchOrgPool__c[0].Id, 'shared-pool');
    const proof = JSON.parse(readFileSync(stateFile, 'utf8')).proof;
    if (['cleanup-failure', 'signup-not-visible', 'active-signup-not-visible'].includes(scenario)) {
      assert.equal(proof.cleanup, undefined);
      await assert.rejects(main(args, fixture), /prior proof needs recovery/);
      if (['signup-not-visible', 'active-signup-not-visible'].includes(scenario)) {
        await assert.rejects(main(['revoke-app', ...args.slice(1)], fixture), /Recover the owned scratch/);
        await assert.rejects(
          main(['cleanup-proof', ...args.slice(1)], fixture),
          /(?:signup|scratch).*not yet observable/
        );
        assert.deepEqual(removed, []);
        signedUp = true;
        scratchVisible = true;
        const recovered = await main(['cleanup-proof', ...args.slice(1)], fixture);
        assert.equal(recovered.proofs[0].cleanup.scratchDeleted, true);
        assert.equal(recovered.proofs[0].cleanup.poolDeleted, true);
        assert.deepEqual(removed, [
          ['ActiveScratchOrg', 'own-scratch'],
          ['ALV_ScratchOrgPoolSlot__c', 'own-slot'],
          ['ALV_ScratchOrgPool__c', 'own-pool']
        ]);
      }
    } else {
      assert.equal(proof.cleanup.scratchDeleted, true);
      assert.equal(proof.cleanup.poolDeleted, true);
    }
    assert.equal(Boolean(proof.completedAt), ['success', 'cleanup-failure'].includes(scenario));
  });
}

test('runtime setup rejects inherited metadata administration instead of using or removing unrelated grants', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [
    {
      Id: 'other-assignment',
      PermissionSetId: 'other-permission',
      PermissionSet: { Name: 'UnrelatedMetadataAdmin', PermissionsModifyMetadata: true }
    }
  ];
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Runtime identity has administrative grants/
  );
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

test('runtime setup requires actual ScratchOrgInfo creation permission after the scoped deployment', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  fixture.records.PermissionSet = [
    {
      Id: '0PSruntime',
      Name: 'ALV_ScratchOrgPoolService',
      IsOwnedByProfile: false,
      Type: 'Regular',
      NamespacePrefix: null,
      ...Object.fromEntries(
        Object.entries(fixture.records.Profile[0]).filter(([name]) => name.startsWith('Permissions'))
      )
    }
  ];
  const grants = addRuntimeGrantInventory(fixture);
  grants.ObjectPermissions.find(item => item.SobjectType === 'ScratchOrgInfo').PermissionsCreate = false;
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Runtime object grants differ/
  );
  assert.deepEqual(fixture.records.PermissionSetAssignment, [], 'Incomplete grants must fail before assignment');
});

test('a concrete scratch-object license restriction is recorded privately for the explicit Salesforce fallback', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  fixture.records.PermissionSet = [
    {
      Id: '0PSruntime',
      Name: 'ALV_ScratchOrgPoolService',
      IsOwnedByProfile: false,
      Type: 'Regular',
      NamespacePrefix: null,
      ...Object.fromEntries(
        Object.entries(fixture.records.Profile[0]).filter(([name]) => name.startsWith('Permissions'))
      )
    }
  ];
  addRuntimeGrantInventory(fixture);
  const invoke = fixture.sf;
  fixture.sf = async (args, options) => {
    if (args[0] === 'project')
      return { success: true, status: 'Succeeded', checkOnly: args.includes('--dry-run'), id: '0Afpermissions' };
    if (args[1] === 'create' && args.includes('PermissionSetAssignment'))
      throw Object.assign(
        new Error('FIELD_INTEGRITY_EXCEPTION: user license does not allow ScratchOrgInfo. private-token-value'),
        { code: 'FIELD_INTEGRITY_EXCEPTION' }
      );
    return invoke(args, options);
  };
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /permission assignment failed/
  );
  const contents = readFileSync(path.join(directory, 'identity.json'), 'utf8');
  const failure = JSON.parse(contents).integrationFailure;
  assert.equal(failure.licenseRestriction, true);
  assert.deepEqual(failure.affectedObjects, ['ScratchOrgInfo']);
  assert.doesNotMatch(contents, /private-token-value/);
  assert.equal(
    fixture.records.User[0].ProfileId,
    '00eintegration',
    'Recording a restriction does not silently switch the user'
  );
});

test('runtime setup rejects missing pool field grants even when scratch creation is granted', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  fixture.records.PermissionSet = [
    {
      Id: '0PSruntime',
      Name: 'ALV_ScratchOrgPoolService',
      IsOwnedByProfile: false,
      Type: 'Regular',
      NamespacePrefix: null,
      ...Object.fromEntries(
        Object.entries(fixture.records.Profile[0]).filter(([name]) => name.startsWith('Permissions'))
      )
    }
  ];
  const grants = addRuntimeGrantInventory(fixture);
  grants.FieldPermissions = [];
  await assert.rejects(
    main(['grant-runtime', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /Runtime field grants differ/
  );
  assert.deepEqual(fixture.records.PermissionSetAssignment, [], 'Incomplete grants must fail before assignment');
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'identity.json'), 'utf8')).runtime, undefined);
});

test('a common trigger or infrastructure failure never qualifies for the Salesforce-license fallback', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.runtimeFailure = { code: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', license: 'integration' };
  writeFileSync(stateFile, JSON.stringify(state));
  await assert.rejects(
    main(['use-salesforce-fallback', ...baseArgs.slice(1), '--state-dir', directory], fixture),
    /recorded Integration incompatibility/
  );
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

test('remote failures expose only a recognized category, without secrets or misleading license fallback evidence', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  const invoke = fixture.sf;
  fixture.sf = async args => {
    if (args[1] === 'create')
      throw Object.assign(new Error('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY private-token-value'), {
        code: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY'
      });
    return invoke(args);
  };
  await assert.rejects(main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture), error => {
    assert.doesNotMatch(error.message, /private-token-value/);
    assert.match(error.message, /CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY/);
    assert.equal(error.licenseRestriction, false);
    return true;
  });
});

test('the native proof refuses cached identity or unconfigured app state before scratch or pool mutation', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
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
    /configured owned app and verified runtime grants/
  );
  assert.deepEqual(
    fixture.created.map(item => item.object),
    ['User', 'PermissionSetLicenseAssign']
  );
});

test('the explicit supported fallback preserves the user and resumes an uncertain profile update without duplicating it', async t => {
  const fixture = provisioningFixture();
  const directory = stateDirectory(t);
  await main(['provision-user', ...baseArgs.slice(1), '--state-dir', directory], fixture);
  fixture.records.PermissionSetAssignment = [];
  const stateFile = path.join(directory, 'identity.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.integrationFailure = {
    phase: 'permission-set-assignment',
    code: 'FIELD_INTEGRITY_EXCEPTION',
    license: 'integration',
    licenseRestriction: true,
    affectedObjects: ['ScratchOrgInfo']
  };
  writeFileSync(stateFile, JSON.stringify(state));
  const invoke = fixture.sf;
  let profileWrites = 0;
  fixture.sf = async args => {
    if (args[0] === 'data' && args[1] === 'delete') {
      assert.equal(args[args.indexOf('--sobject') + 1], 'PermissionSetLicenseAssign');
      assert.equal(args[args.indexOf('--record-id') + 1], '2LApsl');
      fixture.records.PermissionSetLicenseAssign = [];
      return { id: '2LApsl', success: true };
    }
    if (args[0] === 'data' && args[1] === 'update') {
      assert.equal(args[args.indexOf('--record-id') + 1], '005runtime');
      assert.equal(args[args.indexOf('--values') + 1], "ProfileId='00esalesforce'");
      fixture.records.User[0].ProfileId = '00esalesforce';
      profileWrites += 1;
      throw Object.assign(new Error('Uncertain network result'), { code: 'ETIMEDOUT' });
    }
    return invoke(args);
  };
  const args = ['use-salesforce-fallback', ...baseArgs.slice(1), '--state-dir', directory];
  await assert.rejects(main(args, fixture), /profile update is unconfirmed/);
  const result = await main(args, fixture);
  assert.equal(result.status, 'fallback-ready');
  assert.equal(result.userId, '005runtime');
  assert.equal(result.profile, 'Minimum Access - Salesforce');
  assert.equal(profileWrites, 1);
  assert.equal(fixture.records.User.length, 1);
  assert.equal(fixture.records.PermissionSetLicenseAssign.length, 0);
});
