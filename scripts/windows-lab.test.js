const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertLabGroup,
  generatePassword,
  minutesUntil,
  parseBootstrapOutput,
  parseRequest,
  planUp,
  redact,
  runCli,
  shutdownTimeUtc
} = require('./windows-lab');

function fakeDeps(respond) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    deps: {
      home: '/nonexistent',
      now: () => new Date('2026-11-07T12:00:00Z'),
      log: message => logs.push(message),
      az: (args, options = {}) => {
        calls.push(args);
        const result = respond(args) ?? { status: 0, stdout: '', stderr: '' };
        if (result.status !== 0 && !options.allowFailure) throw new Error(`az failed: ${result.stderr}`);
        return result;
      },
      keychainDelete: group => calls.push(['keychain-delete', group])
    }
  };
}

function isCall(args, ...prefix) {
  return prefix.every((word, index) => args[index] === word);
}

test('assertLabGroup accepts lab groups and refuses everything else', () => {
  assert.equal(assertLabGroup('rg-alv-windows-lab-eastus'), 'rg-alv-windows-lab-eastus');
  for (const name of [
    'rg-apex-log-viewer-telemetry-eastus',
    'rg-apex-log-viewer-publishing',
    'rg-alv-windows-lab-',
    'rg-alv-windows-lab-eastus2/../other',
    'xrg-alv-windows-lab-eastus',
    '',
    undefined
  ]) {
    assert.throws(() => assertLabGroup(name), /Refusing resource group/);
  }
});

test('destroy of a production group fails before any Azure call', async () => {
  const { calls, deps } = fakeDeps(() => {
    throw new Error('az must not run');
  });
  await assert.rejects(
    runCli(['destroy', '--resource-group', 'rg-apex-log-viewer-publishing'], deps),
    /Refusing resource group "rg-apex-log-viewer-publishing"/
  );
  assert.deepEqual(calls, []);
});

test('destroy refuses a matching group that lacks the lab tag', async () => {
  const { calls, deps } = fakeDeps(args => {
    if (isCall(args, 'group', 'exists')) return { status: 0, stdout: 'true\n', stderr: '' };
    if (isCall(args, 'group', 'show')) return { status: 0, stdout: '\n', stderr: '' };
    return undefined;
  });
  await assert.rejects(runCli(['destroy'], deps), /lacks the tag alv-lab=windows/);
  assert.equal(calls.filter(args => isCall(args, 'group', 'delete')).length, 0);
});

test('destroy deletes only the tagged lab group, and repeats safely', async () => {
  let exists = true;
  const { calls, deps } = fakeDeps(args => {
    if (isCall(args, 'group', 'exists')) return { status: 0, stdout: `${exists}\n`, stderr: '' };
    if (isCall(args, 'group', 'show')) return { status: 0, stdout: 'windows\n', stderr: '' };
    if (isCall(args, 'group', 'delete')) exists = false;
    return undefined;
  });
  assert.equal(await runCli(['destroy'], deps), 0);
  assert.equal(await runCli(['destroy'], deps), 0);
  const deletes = calls.filter(args => isCall(args, 'group', 'delete'));
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0][3], 'rg-alv-windows-lab-eastus');
});

test('destroy of an absent lab deletes only the password of its own group', async () => {
  const { calls, deps } = fakeDeps(args =>
    isCall(args, 'group', 'exists') ? { status: 0, stdout: 'false\n', stderr: '' } : undefined
  );
  assert.equal(await runCli(['destroy', '--location', 'westus'], deps), 0);
  assert.deepEqual(
    calls.filter(args => args[0] === 'keychain-delete'),
    [['keychain-delete', 'rg-alv-windows-lab-westus']]
  );
});

test('each lab reads its own known hosts file', async () => {
  const knownHostsFiles = [];
  const { deps } = fakeDeps(args =>
    isCall(args, 'network', 'public-ip', 'show') ? { status: 0, stdout: '192.0.2.1\n', stderr: '' } : undefined
  );
  deps.runSsh = async args => {
    knownHostsFiles.push(args.find(arg => arg.startsWith('UserKnownHostsFile=')));
    return 0;
  };
  for (const location of ['eastus', 'westus']) {
    assert.equal(await runCli(['ssh', '--location', location, '--', 'true'], deps), 0);
  }
  assert.deepEqual(knownHostsFiles, [
    'UserKnownHostsFile=/nonexistent/known_hosts-rg-alv-windows-lab-eastus',
    'UserKnownHostsFile=/nonexistent/known_hosts-rg-alv-windows-lab-westus'
  ]);
});

test('down skips what is already gone', async () => {
  const { calls, deps } = fakeDeps(args => {
    if (isCall(args, 'group', 'exists')) return { status: 0, stdout: 'true\n', stderr: '' };
    if (isCall(args, 'vm', 'show')) return { status: 3, stdout: '', stderr: 'ResourceNotFound' };
    if (isCall(args, 'network', 'public-ip', 'show')) return { status: 3, stdout: '', stderr: 'ResourceNotFound' };
    return undefined;
  });
  assert.equal(await runCli(['down'], deps), 0);
  assert.equal(calls.filter(args => isCall(args, 'vm', 'deallocate')).length, 0);
  assert.equal(calls.filter(args => isCall(args, 'network', 'public-ip', 'delete')).length, 0);
});

test('rdp writes a private connection file and never prints the password or the address', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-lab-'));
  const opened = [];
  const { deps, logs } = fakeDeps(args => {
    if (isCall(args, 'network', 'public-ip', 'show')) return { status: 0, stdout: '203.0.113.9\n', stderr: '' };
    return undefined;
  });
  try {
    await runCli(['rdp'], {
      ...deps,
      home,
      openFile: file => {
        opened.push(file);
        return true;
      }
    });
    assert.match(fs.readFileSync(opened[0], 'utf8'), /full address:s:203\.0\.113\.9/);
    assert.ok(logs.some(line => line.includes('security find-generic-password')));
    assert.ok(logs.every(line => !line.includes('203.0.113.9')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('parseRequest derives the group from the location and validates input', () => {
  assert.equal(parseRequest(['status', '--location', 'brazilsouth']).group, 'rg-alv-windows-lab-brazilsouth');
  assert.deepEqual(parseRequest(['ssh', '--', 'pnpm', 'run', '--silent', 'x']).remote, [
    'pnpm',
    'run',
    '--silent',
    'x'
  ]);
  assert.throws(() => parseRequest(['up', '--ref', '--upload-pack=x']), /--ref|argument/);
  assert.throws(() => parseRequest(['up', '--ref', '$(whoami)']), /--ref/);
  assert.throws(() => parseRequest(['up', '--hours', '0.1']), /--hours/);
  assert.throws(() => parseRequest(['up', '--hours', '24']), /--hours/);
  assert.throws(() => parseRequest(['up', '--hours', 'soon']), /--hours/);
  assert.throws(() => parseRequest(['format-disk']), /Unknown command/);
});

test('shutdownTimeUtc rounds up to the minute and crosses midnight', () => {
  assert.equal(shutdownTimeUtc(new Date('2026-11-07T12:00:00Z'), 4), '1600');
  assert.equal(shutdownTimeUtc(new Date('2026-11-07T12:00:20Z'), 4), '1601');
  assert.equal(shutdownTimeUtc(new Date('2026-11-07T22:30:00Z'), 4), '0230');
});

test('minutesUntil counts forward across midnight', () => {
  assert.equal(minutesUntil(new Date('2026-11-07T12:00:00Z'), '1600'), 240);
  assert.equal(minutesUntil(new Date('2026-11-07T22:30:00Z'), '0230'), 240);
});

test('redact hides subscription IDs and addresses', () => {
  const text = 'Failed /subscriptions/12345678-90ab-cdef-1234-567890abcdef/x from 203.0.113.9 port 22';
  assert.equal(redact(text), 'Failed /subscriptions/<id>/x from <ip> port 22');
});

test('planUp creates the default size and starts a deallocated VM', () => {
  const size = 'Standard_D4s_v4';
  assert.deepEqual(planUp(null, {}), { size, recreate: false, start: false });
  const deallocated = { power: 'VM deallocated', provisioning: 'Succeeded', size };
  assert.deepEqual(planUp(deallocated, {}), { size, recreate: false, start: true });
});

test('planUp keeps the size a VM has unless a flag asks for another', () => {
  const size = 'Standard_D2s_v4';
  const running = { power: 'VM running', provisioning: 'Succeeded', size };
  assert.deepEqual(planUp(running, {}), { size, recreate: false, start: false });
  assert.equal(planUp(running, { size: 'Standard_D4s_v4' }).size, 'Standard_D4s_v4');
});

test('planUp replaces only a VM that failed to provision', () => {
  const size = 'Standard_D4s_v4';
  const failed = { power: null, provisioning: 'Failed', size };
  assert.deepEqual(planUp(failed, {}), { size, recreate: true, start: false });
});

test('parseBootstrapOutput requires the sentinel and the host key', () => {
  const ok = [
    'Enable succeeded:',
    '[stdout]',
    'ALV_STEP=git 12s',
    'ALV_PNPM=11.11.0',
    'ALV_NODE=v24.15.0',
    'ALV_HOST_KEY=ssh-ed25519 AAAAkey root@lab',
    'ALV_BOOTSTRAP_OK',
    '[stderr]'
  ].join('\r\n');
  const parsed = parseBootstrapOutput(ok);
  assert.equal(parsed.hostKey, 'ssh-ed25519 AAAAkey');
  assert.equal(parsed.versions.node, 'v24.15.0');
  assert.deepEqual(parsed.steps, ['git 12s']);

  assert.throws(() => parseBootstrapOutput('ALV_HOST_KEY=ssh-ed25519 AAAAkey\n[stderr]\nboom'), /did not finish/);
  assert.throws(() => parseBootstrapOutput('ALV_BOOTSTRAP_OK'), /did not finish/);
});

test('generatePassword meets the Azure complexity rule and differs per call', () => {
  const password = generatePassword();
  assert.match(password, /^Aa1-[A-Za-z0-9_-]{32}$/);
  assert.notEqual(password, generatePassword());
});
