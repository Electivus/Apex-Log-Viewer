const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureHostVolumeMountpoints, resolveComposeArgs } = require('./run-e2e-proxy-lab');

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
  assert.match(mainBody, /spawn\(docker,/);
});

test('proxy lab compose uses mitmproxy with a shared CA volume instead of Tinyproxy', () => {
  const compose = readComposeFile();

  assert.match(compose, /dockerfile:\s+test\/e2e\/proxy-lab\/Dockerfile\.proxy/);
  assert.match(compose, /^\s+- e2e_proxy_mitmproxy_ca:\/mitmproxy$/m);
  assert.match(compose, /^\s+- e2e_proxy_mitmproxy_ca:\/mitmproxy:ro$/m);
  assert.match(compose, /mitmproxy-ca-cert\.cer/);
  assert.match(compose, /ALV_TEST_TELEMETRY_CONNECTION_STRING:/);
  assert.match(compose, /ALV_TEST_TELEMETRY_RUN_ID:/);
  assert.match(compose, /^\s+VSCODE_TEST_DOWNLOAD_TIMEOUT_MS: \$\{VSCODE_TEST_DOWNLOAD_TIMEOUT_MS:-\}$/m);
  assert.doesNotMatch(compose, /tinyproxy/i);
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
    /apt-get install -y --no-install-recommends \\\n(?<packages>[\s\S]*?)\n\s*&& rm -rf \/var\/lib\/apt\/lists\/\*/
  )?.groups.packages;

  assert.ok(aptInstallBlock, 'expected runner Dockerfile to contain an apt package list');
  assert.match(aptInstallBlock, /^\s+xvfb\s+\\$/m);
  assert.match(aptInstallBlock, /^\s+xauth\s+\\$/m);
});
