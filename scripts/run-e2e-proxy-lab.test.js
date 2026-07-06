const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureHostVolumeMountpoints,
  normalizeSalesforceCliPackage,
  parseProxyLabArgs,
  resolveComposeArgs,
  resolveProxyLabEnv
} = require('./run-e2e-proxy-lab');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function readComposeFile() {
  return read('docker-compose.e2e-proxy.yml');
}

function readProxyLabScript() {
  return read('test/e2e/proxy-lab/run.sh');
}

function readRunnerDockerfile() {
  return read('test/e2e/proxy-lab/Dockerfile.runner');
}

function readProxyDockerfile() {
  return read('test/e2e/proxy-lab/Dockerfile.proxy');
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

test('resolveComposeArgs runs the proxy lab runner with the compose file', () => {
  const repoRoot = path.join('/workspace', 'apex-log-viewer');
  assert.deepEqual(resolveComposeArgs([], { repoRoot }), [
    'compose',
    '-f',
    path.join(repoRoot, 'docker-compose.e2e-proxy.yml'),
    'run',
    '--rm',
    '--build',
    'runner'
  ]);
});

test('resolveComposeArgs forwards an explicit E2E command through the lab script', () => {
  const repoRoot = path.join('/workspace', 'apex-log-viewer');
  assert.deepEqual(resolveComposeArgs(['npm', 'run', 'test:e2e:cli'], { repoRoot }), [
    'compose',
    '-f',
    path.join(repoRoot, 'docker-compose.e2e-proxy.yml'),
    'run',
    '--rm',
    '--build',
    'runner',
    'bash',
    'test/e2e/proxy-lab/run.sh',
    'npm',
    'run',
    'test:e2e:cli'
  ]);
});

test('parseProxyLabArgs captures Salesforce CLI package override before the child command', () => {
  assert.deepEqual(parseProxyLabArgs(['--sf-cli-package', '@salesforce/cli@nightly', 'npm', 'run', 'test:e2e:cli']), {
    commandArgs: ['npm', 'run', 'test:e2e:cli'],
    sfCliPackage: '@salesforce/cli@nightly'
  });
});

test('parseProxyLabArgs supports equals syntax and command delimiter', () => {
  assert.deepEqual(parseProxyLabArgs(['--sf-cli-package=@salesforce/cli@nightly', '--', 'npm', 'run', 'test:e2e']), {
    commandArgs: ['npm', 'run', 'test:e2e'],
    sfCliPackage: '@salesforce/cli@nightly'
  });
});

test('parseProxyLabArgs requires a Salesforce CLI package value', () => {
  assert.throws(() => parseProxyLabArgs(['--sf-cli-package']), /--sf-cli-package requires a package specifier/);
});

test('Salesforce CLI package overrides are constrained to the official CLI package', () => {
  assert.equal(normalizeSalesforceCliPackage(' @salesforce/cli@2.136.8 '), '@salesforce/cli@2.136.8');
  assert.equal(normalizeSalesforceCliPackage('@salesforce/cli@nightly'), '@salesforce/cli@nightly');
  assert.throws(
    () => normalizeSalesforceCliPackage('evil-package@1.0.0'),
    /must be @salesforce\/cli pinned to an exact version/
  );
  assert.throws(
    () => normalizeSalesforceCliPackage('@salesforce/cli'),
    /must be @salesforce\/cli pinned to an exact version/
  );
});

test('ensureHostVolumeMountpoints creates Docker volume mountpoints before compose runs', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-proxy-lab-'));

  try {
    ensureHostVolumeMountpoints(repoRoot);

    for (const relativePath of ['node_modules', 'target', '.vscode-test']) {
      const fullPath = path.join(repoRoot, relativePath);
      assert.equal(fs.statSync(fullPath).isDirectory(), true, `expected ${relativePath} to be a directory`);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('proxy lab runner prepares host volume mountpoints before spawning compose', () => {
  const script = read('scripts/run-e2e-proxy-lab.js');
  const mainBody = script.match(/function main\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups.body;

  assert.ok(mainBody, 'expected run-e2e-proxy-lab.js to define main()');
  assert.match(mainBody, /ensureHostVolumeMountpoints\(repoRoot\)/);
  assert.match(mainBody, /resolveProxyLabEnv\(process\.env, process,/);
  assert.match(mainBody, /spawn\(docker,/);
});

test('resolveProxyLabEnv forwards the host uid and gid for bind-mounted cleanup', () => {
  const env = resolveProxyLabEnv(
    { EXISTING_ENV: '1' },
    {
      getuid: () => 1001,
      getgid: () => 1002
    }
  );

  assert.equal(env.EXISTING_ENV, '1');
  assert.equal(env.ALV_E2E_PROXY_LAB_HOST_UID, '1001');
  assert.equal(env.ALV_E2E_PROXY_LAB_HOST_GID, '1002');
});

test('resolveProxyLabEnv forwards a Salesforce CLI package override', () => {
  const env = resolveProxyLabEnv({ EXISTING_ENV: '1' }, {}, { sfCliPackage: '@salesforce/cli@nightly' });

  assert.equal(env.EXISTING_ENV, '1');
  assert.equal(env.ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE, '@salesforce/cli@nightly');
});

test('proxy lab compose forwards host ownership ids into the runner', () => {
  const compose = readComposeFile();

  assert.match(compose, /^\s+ALV_E2E_PROXY_LAB_HOST_UID: \$\{ALV_E2E_PROXY_LAB_HOST_UID:-\}$/m);
  assert.match(compose, /^\s+ALV_E2E_PROXY_LAB_HOST_GID: \$\{ALV_E2E_PROXY_LAB_HOST_GID:-\}$/m);
});

test('proxy lab compose forwards the Salesforce CLI package override into the runner', () => {
  const compose = readComposeFile();

  assert.match(compose, /^\s+ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE: \$\{ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE:-\}$/m);
});

test('proxy lab compose persists runner caches and Salesforce CLI auth state', () => {
  const compose = readComposeFile();

  for (const [volume, mountPath] of [
    ['e2e_proxy_node_modules', '/workspace/node_modules'],
    ['e2e_proxy_vscode_test', '/workspace/.vscode-test'],
    ['e2e_proxy_npm_cache', '/root/.npm'],
    ['e2e_proxy_sf', '/root/.sf'],
    ['e2e_proxy_sfdx', '/root/.sfdx']
  ]) {
    assert.match(compose, new RegExp(`^\\s+- ${escapeRegExp(volume)}:${escapeRegExp(mountPath)}$`, 'm'));
    assert.match(compose, new RegExp(`^\\s{2}${escapeRegExp(volume)}: \\{\\}$`, 'm'));
  }
});

test('proxy lab runner restores ownership of bind-mounted generated outputs on exit', () => {
  const script = readProxyLabScript();

  assert.match(script, /restore_host_ownership\(\)/);
  assert.match(script, /trap restore_host_ownership EXIT/);
  assert.match(script, /ALV_E2E_PROXY_LAB_HOST_UID/);
  assert.match(script, /apps\/vscode-extension\/bin/);
  assert.match(script, /output/);
  assert.doesNotMatch(script, /exec "\$@"/);
  assert.doesNotMatch(script, /exec bash -lc/);
  assert.doesNotMatch(script, /exec npm run test:e2e/);
});

test('proxy lab compose uses mitmproxy with a shared CA volume instead of Tinyproxy', () => {
  const compose = readComposeFile();
  const dockerfile = readProxyDockerfile();

  assert.match(compose, /dockerfile:\s+test\/e2e\/proxy-lab\/Dockerfile\.proxy/);
  assert.match(compose, /^\s+- e2e_proxy_mitmproxy_ca:\/mitmproxy$/m);
  assert.match(compose, /^\s+- e2e_proxy_mitmproxy_ca:\/mitmproxy:ro$/m);
  assert.match(compose, /mitmproxy-ca-cert\.cer/);
  assert.match(compose, /ALV_TEST_TELEMETRY_CONNECTION_STRING:/);
  assert.match(compose, /ALV_TEST_TELEMETRY_RUN_ID:/);
  assert.match(compose, /^\s+VSCODE_TEST_DOWNLOAD_TIMEOUT_MS: \$\{VSCODE_TEST_DOWNLOAD_TIMEOUT_MS:-\}$/m);
  assert.doesNotMatch(compose, /tinyproxy/i);
  assert.match(dockerfile, /"stream_large_bodies=1m"/);
});

test('proxy lab runner script validates MITM trust before running E2E commands', () => {
  const script = readProxyLabScript();

  assert.match(script, /wait_for_mitm_ca/);
  assert.match(script, /Verifying authenticated HTTPS fails before trusting the MITM CA/);
  assert.match(script, /update-ca-certificates/);
  assert.match(script, /NODE_EXTRA_CA_CERTS/);
  assert.match(script, /SSL_CERT_FILE/);
  assert.match(script, /Verifying internet egress works through the authenticated MITM proxy/);
  assert.match(script, /verify_node_https_proxy/);
  assert.match(script, /Node HTTPS through the configured MITM proxy/);
  assert.doesNotMatch(script, /Node fetch/);
  assert.match(script, /preflight_salesforce_cli/);
});

test('proxy lab runner can install an explicit Salesforce CLI package before preflight', () => {
  const script = readProxyLabScript();

  assert.match(script, /install_salesforce_cli_override\(\)/);
  assert.match(script, /ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE/);
  assert.match(script, /validate_salesforce_cli_package/);
  assert.match(script, /npm install --global "\$\{package_name\}"/);
  assert.match(script, /sf --version/);
  assert.match(
    script,
    /verify_node_https_proxy\s*\ninstall_salesforce_cli_override\s*\npreflight_salesforce_cli/,
    'expected the Salesforce CLI override install to run after proxy validation and before Salesforce preflight'
  );
});

test('proxy lab runner requires Dev Hub auth for real-org commands only', () => {
  const script = readProxyLabScript();

  assert.match(script, /requested_command_requires_devhub\(\)/);
  assert.match(script, /SF_DEVHUB_AUTH_URL is required for real-org proxy-lab commands/);
  assert.match(script, /clean runner container cannot use host Salesforce CLI aliases/);
  assert.match(script, /if \[\[ "\$#" -eq 0 && -z "\$\{ALV_E2E_PROXY_LAB_COMMAND:-\}" \]\]; then/);
  assert.match(script, /\*"test:e2e"\*/);
  assert.match(script, /requested command does not look like a real-org E2E run/);
  assert.match(script, /preflight_salesforce_cli "\$@"/);
});

test('proxy lab sf preflight preserves failed command exit status', () => {
  const script = readProxyLabScript();
  const body = script.match(/run_sf_preflight_command\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups.body;

  assert.ok(body);
  assert.match(body, /local status=0/);
  assert.match(body, /"\$@" >"\$\{output_file\}" 2>&1 \|\| status=\$\?/);
  assert.match(body, /if \[\[ "\$\{status\}" -eq 0 \]\]; then/);
  assert.doesNotMatch(body, /local status=\$\?/);
});

test('proxy lab runner guards against proxy auth and Node dependency regressions', () => {
  const script = readProxyLabScript();
  const unauthenticatedProxyCheck = script.match(/verify_unauthenticated_proxy_blocked\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups.body;
  const connectParser = script.match(/function readProxyConnectResponse\(socket\) \{(?<body>[\s\S]*?)\n\}\n\nfunction connectTls/)?.groups.body;

  assert.ok(unauthenticatedProxyCheck);
  assert.match(unauthenticatedProxyCheck, /http:\/\/example\.com/);
  assert.match(unauthenticatedProxyCheck, /407/);
  assert.doesNotMatch(unauthenticatedProxyCheck, /https:\/\/example\.com/);
  assert.ok(connectParser);
  assert.match(connectParser, /let settled = false/);
  assert.match(connectParser, /function settle/);
  assert.match(connectParser, /function onEnd/);
  assert.match(connectParser, /function onClose/);
  assert.match(connectParser, /socket\.off\('end', onEnd\)/);
  assert.match(connectParser, /socket\.off\('close', onClose\)/);
  assert.match(connectParser, /socket\.once\('end', onEnd\)/);
  assert.match(connectParser, /socket\.once\('close', onClose\)/);
  assert.doesNotMatch(script, /require\(['"]undici['"]\)/);
  assert.match(script, /require\(['"]node:net['"]\)/);
  assert.match(script, /require\(['"]node:tls['"]\)/);
  assert.match(script, /require\(['"]node:buffer['"]\)/);
  assert.match(script, /require\(['"]node:url['"]\)/);
  assert.match(script, /trap 'rm -f "\$\{auth_file\}"' RETURN ERR/);
});

test('proxy lab runner image installs xauth for xvfb-run', () => {
  const dockerfile = readRunnerDockerfile();
  const aptInstallBlock = dockerfile.match(
    /apt-get install -y --no-install-recommends \\\r?\n(?<packages>[\s\S]*?)\r?\n\s*&& rm -rf \/var\/lib\/apt\/lists\/\*/
  )?.groups.packages;

  assert.ok(aptInstallBlock, 'expected runner Dockerfile to contain an apt package list');
  assert.match(aptInstallBlock, /^\s+xvfb\s+\\$/m);
  assert.match(aptInstallBlock, /^\s+xauth\s+\\$/m);
});

test('proxy lab Docker images are pinned by digest', () => {
  const runnerDockerfile = readRunnerDockerfile();
  const proxyDockerfile = readProxyDockerfile();

  assert.match(runnerDockerfile, /^FROM rust:1\.95\.0-bookworm@sha256:[0-9a-f]{64} AS rust-toolchain$/m);
  assert.match(runnerDockerfile, /^FROM node:24\.15\.0-bookworm@sha256:[0-9a-f]{64}$/m);
  assert.match(proxyDockerfile, /^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/m);
});

test('proxy lab Dockerfiles bound apt network waits during image builds', () => {
  for (const [name, dockerfile] of [
    ['runner', readRunnerDockerfile()],
    ['proxy', readProxyDockerfile()]
  ]) {
    assert.match(
      dockerfile,
      /ALV_E2E_PROXY_LAB_APT_TIMEOUT_SECONDS=20/,
      `expected ${name} Dockerfile to define a short apt network timeout`
    );
    assert.match(
      dockerfile,
      /ALV_E2E_PROXY_LAB_APT_RETRIES=3/,
      `expected ${name} Dockerfile to define bounded apt retries`
    );
    assert.match(
      dockerfile,
      /Acquire::Retries \\"\$\{ALV_E2E_PROXY_LAB_APT_RETRIES\}\\";/,
      `expected ${name} Dockerfile apt-get calls to retry transient apt failures`
    );
    assert.match(
      dockerfile,
      /Acquire::http::Timeout \\"\$\{ALV_E2E_PROXY_LAB_APT_TIMEOUT_SECONDS\}\\";/,
      `expected ${name} Dockerfile apt-get calls to time out stalled HTTP mirrors`
    );
    assert.match(
      dockerfile,
      /Acquire::https::Timeout \\"\$\{ALV_E2E_PROXY_LAB_APT_TIMEOUT_SECONDS\}\\";/,
      `expected ${name} Dockerfile apt-get calls to time out stalled HTTPS mirrors`
    );
    assert.match(
      dockerfile,
      /\/etc\/apt\/apt\.conf\.d\/99alv-proxy-lab-timeouts/,
      `expected ${name} Dockerfile to apply the apt timeout config before apt-get`
    );
  }
});
