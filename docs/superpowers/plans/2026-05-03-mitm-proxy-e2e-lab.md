# MITM Proxy E2E Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run test:e2e:proxy-lab` simulate a corporate TLS MITM proxy by default, validate the untrusted-CA failure and trusted-CA success paths, and run the standard real-org GitHub E2E workflow through that lab.

**Architecture:** Replace the Tinyproxy sidecar with a `mitmdump` sidecar that writes its generated CA to a shared Docker volume. The runner remains on an internal-only network, proves direct egress and unauthenticated proxy failures, proves HTTPS fails before trusting the MITM CA, installs the CA into the OS trust store, exports CA env vars for Node/OpenSSL-compatible tools, and then runs the requested real-org E2E command. The telemetry wrapper keeps Azure resolution on the GitHub runner host while launching its Playwright child command through the proxy lab.

**Tech Stack:** Docker Compose with Podman-compatible Docker CLI, Debian runner/proxy images, mitmproxy/mitmdump, Bash, Node.js 22, npm, Playwright, Salesforce CLI, GitHub Actions YAML, Rust runtime via existing npm scripts.

---

## Approved spec

- `docs/superpowers/specs/2026-05-03-mitm-proxy-e2e-lab-design.md`
- Commit containing the approved spec: `9405a6d docs(spec): add mitm proxy e2e lab design`

## Worktree

Use this worktree for implementation:

- `/home/k3/git/Apex-Log-Viewer/.worktrees/mitm-proxy-e2e-lab`
- Branch: `feature/mitm-proxy-e2e-lab`

Baseline already completed in this worktree:

- `npm ci`
- `npm run build:runtime`
- `npm run test:e2e:utils`
- `node --test scripts/run-e2e-proxy-lab.test.js`

## File structure

- Modify `scripts/run-e2e-proxy-lab.test.js`
  - Adds static guard tests for the Compose topology and runner trust flow.
- Modify `test/e2e/proxy-lab/Dockerfile.proxy`
  - Replaces Tinyproxy with a mitmdump proxy image built from Debian.
- Delete `test/e2e/proxy-lab/tinyproxy.conf`
  - Tinyproxy is no longer used.
- Modify `docker-compose.e2e-proxy.yml`
  - Adds the shared MITM CA volume, swaps proxy healthcheck to CA readiness, mounts the CA volume read-only into the runner, and forwards telemetry env vars into the runner.
- Modify `test/e2e/proxy-lab/run.sh`
  - Implements the negative and positive MITM CA checks, CA installation, trust env exports, and optional Salesforce CLI Dev Hub preflight.
- Modify `scripts/run-playwright-e2e-telemetry.test.js`
  - Adds tests for proxy-lab child invocation.
- Modify `scripts/run-playwright-e2e-telemetry.js`
  - Adds a `resolvePlaywrightChildInvocation()` helper and uses it in `main()`.
- Modify `scripts/cli-e2e-workflow.test.js`
  - Updates workflow guard tests so CI must run real-org E2E through `test:e2e:proxy-lab`.
- Modify `.github/workflows/e2e-playwright.yml`
  - Runs CLI and extension E2E through the MITM proxy lab.
- Modify `docs/TESTING.md`
  - Documents the MITM lab, trust checks, CI behavior, and local `SF_DEVHUB_AUTH_URL` requirement.

---

### Task 1: Add proxy-lab guard tests

**Files:**
- Modify: `scripts/run-e2e-proxy-lab.test.js`
- Read: `docker-compose.e2e-proxy.yml`
- Read: `test/e2e/proxy-lab/run.sh`

- [ ] **Step 1: Write failing tests for MITM Compose and runner trust flow**

Add `fs` import and file readers near the top of `scripts/run-e2e-proxy-lab.test.js`:

```js
const fs = require('node:fs');
```

Add these helpers below the existing imports:

```js
function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function readComposeFile() {
  return read('docker-compose.e2e-proxy.yml');
}

function readProxyLabScript() {
  return read('test/e2e/proxy-lab/run.sh');
}
```

Append these tests to `scripts/run-e2e-proxy-lab.test.js`:

```js
test('proxy lab compose uses mitmproxy with a shared CA volume instead of Tinyproxy', () => {
  const compose = readComposeFile();

  assert.match(compose, /dockerfile:\s+test\/e2e\/proxy-lab\/Dockerfile\.proxy/);
  assert.match(compose, /e2e_proxy_mitmproxy_ca:\/mitmproxy\b/);
  assert.match(compose, /e2e_proxy_mitmproxy_ca:\/mitmproxy:ro\b/);
  assert.match(compose, /mitmproxy-ca-cert\.cer/);
  assert.match(compose, /ALV_TEST_TELEMETRY_CONNECTION_STRING:/);
  assert.match(compose, /ALV_TEST_TELEMETRY_RUN_ID:/);
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
  assert.match(script, /preflight_salesforce_cli/);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test scripts/run-e2e-proxy-lab.test.js
```

Expected: FAIL. The new tests should fail because the current Compose file still uses Tinyproxy, has no MITM CA volume, and `run.sh` has no MITM trust flow.

- [ ] **Step 3: Commit the failing tests**

```bash
git add scripts/run-e2e-proxy-lab.test.js
git commit -m "test(e2e): specify mitm proxy lab contract"
```

---

### Task 2: Replace Tinyproxy with mitmdump in Compose

**Files:**
- Modify: `test/e2e/proxy-lab/Dockerfile.proxy`
- Delete: `test/e2e/proxy-lab/tinyproxy.conf`
- Modify: `docker-compose.e2e-proxy.yml`
- Test: `scripts/run-e2e-proxy-lab.test.js`

- [ ] **Step 1: Replace `test/e2e/proxy-lab/Dockerfile.proxy`**

Replace the whole file with:

```dockerfile
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    mitmproxy \
    netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /mitmproxy && chmod 0777 /mitmproxy

EXPOSE 8888

CMD ["mitmdump", "--set", "confdir=/mitmproxy", "--listen-host", "0.0.0.0", "--listen-port", "8888", "--proxyauth", "alv-proxy-user:alv-proxy-pass"]
```

- [ ] **Step 2: Delete the Tinyproxy config file**

Delete:

```bash
test/e2e/proxy-lab/tinyproxy.conf
```

- [ ] **Step 3: Update `docker-compose.e2e-proxy.yml` proxy and runner services**

In the `proxy` service:

1. Keep the existing build context and Dockerfile.
2. Add the CA volume mount:

```yaml
    volumes:
      - e2e_proxy_mitmproxy_ca:/mitmproxy
```

3. Replace the healthcheck with:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "test -s /mitmproxy/mitmproxy-ca-cert.cer && nc -z 127.0.0.1 8888"]
      interval: 5s
      timeout: 3s
      retries: 24
```

In the `runner` service, add the read-only CA volume:

```yaml
      - e2e_proxy_mitmproxy_ca:/mitmproxy:ro
```

In the `runner.environment` block, remove this line because `run.sh` exports it only after the CA is trusted:

```yaml
      ALV_E2E_USE_SYSTEM_CA: "1"
```

Add telemetry variables to the same `runner.environment` block:

```yaml
      ALV_ENABLE_TEST_TELEMETRY: ${ALV_ENABLE_TEST_TELEMETRY:-}
      ALV_TEST_TELEMETRY_CONNECTION_STRING: ${ALV_TEST_TELEMETRY_CONNECTION_STRING:-}
      ALV_TEST_TELEMETRY_RUN_ID: ${ALV_TEST_TELEMETRY_RUN_ID:-}
```

Add the new named volume at the bottom:

```yaml
  e2e_proxy_mitmproxy_ca: {}
```

- [ ] **Step 4: Run proxy-lab guard tests**

Run:

```bash
node --test scripts/run-e2e-proxy-lab.test.js
```

Expected: the Compose topology test should pass. The runner trust-flow test should still fail until Task 3 updates `run.sh`.

- [ ] **Step 5: Validate Compose syntax**

Run:

```bash
docker compose -f docker-compose.e2e-proxy.yml config --services
```

Expected output contains:

```text
proxy
runner
```

- [ ] **Step 6: Commit Compose and proxy image changes**

```bash
git add docker-compose.e2e-proxy.yml test/e2e/proxy-lab/Dockerfile.proxy
git rm test/e2e/proxy-lab/tinyproxy.conf
git commit -m "test(e2e): switch proxy lab to mitmproxy"
```

---

### Task 3: Implement runner MITM trust validation

**Files:**
- Modify: `test/e2e/proxy-lab/run.sh`
- Test: `scripts/run-e2e-proxy-lab.test.js`

- [ ] **Step 1: Replace `test/e2e/proxy-lab/run.sh`**

Replace the whole file with:

```bash
#!/usr/bin/env bash
set -euo pipefail

MITM_CA_SOURCE="${ALV_E2E_PROXY_LAB_MITM_CA_SOURCE:-/mitmproxy/mitmproxy-ca-cert.cer}"
MITM_CA_DEST="${ALV_E2E_PROXY_LAB_MITM_CA_DEST:-/usr/local/share/ca-certificates/alv-mitmproxy-ca.crt}"
SYSTEM_CA_BUNDLE="${ALV_E2E_PROXY_LAB_SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
DEVHUB_ALIAS="${SF_DEVHUB_ALIAS:-ConfiguredDevHub}"

fail() {
  echo "[proxy-lab] $*" >&2
  exit 1
}

wait_for_mitm_ca() {
  echo "[proxy-lab] Waiting for mitmproxy CA at ${MITM_CA_SOURCE}..."
  local deadline=$((SECONDS + 120))
  while [[ "${SECONDS}" -lt "${deadline}" ]]; do
    if [[ -s "${MITM_CA_SOURCE}" ]]; then
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for mitmproxy CA at ${MITM_CA_SOURCE}."
}

verify_direct_egress_blocked() {
  echo "[proxy-lab] Verifying that direct internet egress is blocked..."
  if curl --noproxy '*' --connect-timeout 5 --max-time 10 -fsS https://example.com >/dev/null 2>&1; then
    fail "Direct egress unexpectedly succeeded. The runner is not isolated."
  fi
}

verify_unauthenticated_proxy_blocked() {
  echo "[proxy-lab] Verifying that the proxy rejects unauthenticated internet egress..."
  if curl --proxy http://proxy:8888 --connect-timeout 5 --max-time 10 -fsS https://example.com >/dev/null 2>&1; then
    fail "Unauthenticated proxy egress unexpectedly succeeded."
  fi
}

verify_mitm_ca_not_trusted_yet() {
  echo "[proxy-lab] Verifying authenticated HTTPS fails before trusting the MITM CA..."
  local stderr_file
  stderr_file="$(mktemp)"
  if curl --connect-timeout 10 --max-time 30 -fsS https://example.com >/dev/null 2>"${stderr_file}"; then
    rm -f "${stderr_file}"
    fail "Authenticated HTTPS unexpectedly succeeded before the MITM CA was trusted."
  fi
  if ! grep -Eiq 'certificate|SSL|issuer|self-signed|unable to get local issuer' "${stderr_file}"; then
    echo "[proxy-lab] curl failure before CA trust did not look certificate-related:" >&2
    cat "${stderr_file}" >&2
    rm -f "${stderr_file}"
    exit 1
  fi
  rm -f "${stderr_file}"
}

install_mitm_ca() {
  echo "[proxy-lab] Installing mitmproxy CA into the runner trust store..."
  cp "${MITM_CA_SOURCE}" "${MITM_CA_DEST}"
  update-ca-certificates

  export NODE_USE_SYSTEM_CA=1
  export ALV_E2E_USE_SYSTEM_CA=1
  export NODE_EXTRA_CA_CERTS="${MITM_CA_DEST}"
  export SSL_CERT_FILE="${SYSTEM_CA_BUNDLE}"
}

verify_authenticated_mitm_proxy() {
  echo "[proxy-lab] Verifying internet egress works through the authenticated MITM proxy..."
  curl --connect-timeout 10 --max-time 30 -fsS https://example.com >/dev/null
}

install_dependencies() {
  if [[ "${ALV_E2E_PROXY_LAB_SKIP_NPM_CI:-}" != "1" ]]; then
    echo "[proxy-lab] Installing npm dependencies through the MITM proxy..."
    npm ci
  else
    echo "[proxy-lab] Skipping npm ci because ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1."
  fi
}

verify_node_fetch() {
  echo "[proxy-lab] Verifying Node fetch through the configured MITM proxy..."
  node - <<'NODE'
const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());
fetch('https://example.com', { signal: AbortSignal.timeout(30_000) })
  .then(response => {
    if (!response.ok) {
      throw new Error(`Unexpected status ${response.status}`);
    }
  })
  .catch(error => {
    console.error(`[proxy-lab] Node fetch through MITM proxy failed: ${error.message}`);
    process.exitCode = 1;
  });
NODE
}

preflight_salesforce_cli() {
  if [[ -z "${SF_DEVHUB_AUTH_URL:-}" ]]; then
    echo "[proxy-lab] Skipping Salesforce CLI network preflight because SF_DEVHUB_AUTH_URL is not set."
    return 0
  fi

  echo "[proxy-lab] Verifying Salesforce CLI through the authenticated MITM proxy..."
  local auth_file
  auth_file="$(mktemp)"
  chmod 0600 "${auth_file}"
  printf '%s' "${SF_DEVHUB_AUTH_URL}" >"${auth_file}"
  sf org login sfdx-url --sfdx-url-file "${auth_file}" --set-default-dev-hub --alias "${DEVHUB_ALIAS}" --json >/dev/null
  rm -f "${auth_file}"
  sf org display -o "${DEVHUB_ALIAS}" --json >/dev/null
}

run_requested_command() {
  if [[ "$#" -gt 0 ]]; then
    echo "[proxy-lab] Running command: $*"
    exec "$@"
  fi

  if [[ -n "${ALV_E2E_PROXY_LAB_COMMAND:-}" ]]; then
    echo "[proxy-lab] Running command: ${ALV_E2E_PROXY_LAB_COMMAND}"
    exec bash -lc "${ALV_E2E_PROXY_LAB_COMMAND}"
  fi

  echo "[proxy-lab] Running default command: npm run test:e2e"
  exec npm run test:e2e
}

wait_for_mitm_ca
verify_direct_egress_blocked
verify_unauthenticated_proxy_blocked
verify_mitm_ca_not_trusted_yet
install_mitm_ca
verify_authenticated_mitm_proxy
install_dependencies
verify_node_fetch
preflight_salesforce_cli
run_requested_command "$@"
```

- [ ] **Step 2: Run proxy-lab guard tests**

Run:

```bash
node --test scripts/run-e2e-proxy-lab.test.js
```

Expected: PASS.

- [ ] **Step 3: Validate Compose syntax again**

Run:

```bash
docker compose -f docker-compose.e2e-proxy.yml config --services
```

Expected output contains:

```text
proxy
runner
```

- [ ] **Step 4: Commit runner trust flow**

```bash
git add test/e2e/proxy-lab/run.sh scripts/run-e2e-proxy-lab.test.js docker-compose.e2e-proxy.yml
git commit -m "test(e2e): validate mitm proxy trust flow"
```

---

### Task 4: Route telemetry Playwright child runs through proxy lab

**Files:**
- Modify: `scripts/run-playwright-e2e-telemetry.test.js`
- Modify: `scripts/run-playwright-e2e-telemetry.js`

- [ ] **Step 1: Write failing telemetry wrapper tests**

In `scripts/run-playwright-e2e-telemetry.test.js`, add this import:

```js
const path = require('node:path');
```

Change the module destructuring to include `resolvePlaywrightChildInvocation`:

```js
const {
  buildRunValidationQuery,
  resolveConfig,
  resolvePlaywrightChildInvocation,
  spawnAsync,
  summarizeTelemetry
} = require('./run-playwright-e2e-telemetry');
```

Append these tests:

```js
test('resolvePlaywrightChildInvocation runs Playwright directly by default', () => {
  const repoRoot = path.join('/repo', 'apex-log-viewer');
  const invocation = resolvePlaywrightChildInvocation(['--grep', 'logs'], {}, repoRoot);

  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts', 'run-playwright-e2e.js'), '--grep', 'logs']
  });
});

test('resolvePlaywrightChildInvocation can run the Playwright child through the proxy lab', () => {
  const repoRoot = path.join('/repo', 'apex-log-viewer');
  const invocation = resolvePlaywrightChildInvocation(
    ['--grep', 'logs'],
    { ALV_E2E_TELEMETRY_PROXY_LAB: '1' },
    repoRoot
  );

  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [
      path.join(repoRoot, 'scripts', 'run-e2e-proxy-lab.js'),
      'npm',
      'run',
      'test:e2e',
      '--',
      '--grep',
      'logs'
    ]
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test scripts/run-playwright-e2e-telemetry.test.js
```

Expected: FAIL because `resolvePlaywrightChildInvocation` is not exported yet.

- [ ] **Step 3: Implement `resolvePlaywrightChildInvocation()`**

In `scripts/run-playwright-e2e-telemetry.js`, add this helper near `readEnv()`:

```js
function envFlag(env, name) {
  const normalized = String(env[name] || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolvePlaywrightChildInvocation(extraArgs, env = process.env, repoRoot = REPO_ROOT) {
  if (envFlag(env, 'ALV_E2E_TELEMETRY_PROXY_LAB')) {
    return {
      command: process.execPath,
      args: [
        path.join(repoRoot, 'scripts', 'run-e2e-proxy-lab.js'),
        'npm',
        'run',
        'test:e2e',
        '--',
        ...extraArgs
      ]
    };
  }

  return {
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts', 'run-playwright-e2e.js'), ...extraArgs]
  };
}
```

In `main()`, replace the existing `spawnAsync()` call for the Playwright child:

```js
  const child = await spawnAsync(
    process.execPath,
    [path.join(__dirname, 'run-playwright-e2e.js'), ...process.argv.slice(2)],
    {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: 'inherit'
    }
  );
```

with:

```js
  const childInvocation = resolvePlaywrightChildInvocation(process.argv.slice(2), childEnv, REPO_ROOT);
  const child = await spawnAsync(childInvocation.command, childInvocation.args, {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: 'inherit'
  });
```

Update `module.exports` to include the new helper:

```js
  resolvePlaywrightChildInvocation,
```

- [ ] **Step 4: Run telemetry wrapper tests**

Run:

```bash
node --test scripts/run-playwright-e2e-telemetry.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit telemetry wrapper changes**

```bash
git add scripts/run-playwright-e2e-telemetry.js scripts/run-playwright-e2e-telemetry.test.js
git commit -m "test(e2e): run telemetry child through proxy lab"
```

---

### Task 5: Run GitHub real-org E2E through proxy lab

**Files:**
- Modify: `scripts/cli-e2e-workflow.test.js`
- Modify: `.github/workflows/e2e-playwright.yml`

- [ ] **Step 1: Update workflow guard tests first**

In `scripts/cli-e2e-workflow.test.js`, update the assertion in `real-org Playwright workflow runs the CLI suite before the extension suite and uploads separate CLI artifacts` from:

```js
  assert.match(
    String(cliStep.step.run || ''),
    /\bnpm run test:e2e:cli\b/,
    'expected the workflow to run npm run test:e2e:cli in a dedicated CLI real-org step'
  );
```

to:

```js
  assert.match(
    String(cliStep.step.run || ''),
    /\bnpm run test:e2e:proxy-lab -- npm run test:e2e:cli\b/,
    'expected the workflow to run CLI real-org E2E through the MITM proxy lab'
  );
```

Append this test to the file:

```js
test('real-org Playwright workflow runs the extension suite through the MITM proxy lab', () => {
  const workflow = readWorkflow();
  const { step: extensionStep } = getWorkflowStep(workflow, 'Run Playwright E2E');
  const runBlock = String(extensionStep.run || '');

  assert.match(
    runBlock,
    /\bnpm run test:e2e:proxy-lab -- npm run test:e2e\b/,
    'expected the non-telemetry extension suite to run through the MITM proxy lab'
  );
  assert.equal(
    extensionStep.env?.ALV_E2E_TELEMETRY_PROXY_LAB,
    '1',
    'expected telemetry wrapper to launch its Playwright child through the MITM proxy lab'
  );
  assert.equal(
    extensionStep.env?.ALV_E2E_PROXY_LAB_SKIP_NPM_CI,
    '1',
    'expected extension E2E to reuse the dependency volume populated by the CLI proxy-lab step'
  );
});
```

- [ ] **Step 2: Run workflow tests and verify they fail**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected: FAIL because the workflow still runs the E2E commands directly.

- [ ] **Step 3: Update the CLI E2E workflow step**

In `.github/workflows/e2e-playwright.yml`, change the `Run CLI real-org E2E` command from:

```bash
npm run test:e2e:cli
```

to:

```bash
npm run test:e2e:proxy-lab -- npm run test:e2e:cli
```

- [ ] **Step 4: Update the extension E2E workflow step**

In `.github/workflows/e2e-playwright.yml`, keep the telemetry branch on `npm run test:e2e:telemetry` and change only the non-telemetry branch to use the proxy lab:

```bash
if [[ -n "${AZURE_CLIENT_ID}" && -n "${AZURE_TENANT_ID}" && -n "${AZURE_SUBSCRIPTION_ID}" && "${HAS_AZURE_E2E_TELEMETRY_CONFIG}" == "1" ]]; then
  echo "Running full Playwright E2E with dedicated App Insights validation through the MITM proxy lab."
  npm run test:e2e:telemetry
else
  echo "Azure OIDC secrets or E2E telemetry target variables are not fully configured; running the full Playwright E2E suite without telemetry validation through the MITM proxy lab."
  npm run test:e2e:proxy-lab -- npm run test:e2e
fi
```

Add these env vars to the `Run Playwright E2E` step:

```yaml
          ALV_E2E_TELEMETRY_PROXY_LAB: '1'
          ALV_E2E_PROXY_LAB_SKIP_NPM_CI: '1'
```

- [ ] **Step 5: Run workflow tests**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit workflow integration**

```bash
git add .github/workflows/e2e-playwright.yml scripts/cli-e2e-workflow.test.js
git commit -m "ci(e2e): run real-org suites through mitm proxy lab"
```

---

### Task 6: Update testing documentation

**Files:**
- Modify: `docs/TESTING.md`

- [ ] **Step 1: Update the local run examples**

In `docs/TESTING.md`, in the "Run locally" list, replace:

```markdown
- `SF_TEST_KEEP_ORG=1 npm run test:e2e:proxy-lab`
```

with:

```markdown
- `SF_DEVHUB_AUTH_URL=force://REDACTED_DEVHUB_AUTH_URL SF_TEST_KEEP_ORG=1 npm run test:e2e:proxy-lab`
```

- [ ] **Step 2: Replace the corporate proxy lab bullets**

In `docs/TESTING.md`, replace the bullets under "Corporate proxy lab" with:

```markdown
- `runner` is attached only to an internal Docker network, so direct internet egress is blocked.
- `proxy` is attached to both the internal network and an external egress network, exposing mitmproxy on `http://proxy:8888` only inside Compose.
- The proxy requires Basic authentication using test-only credentials in the proxy URL, matching the corporate shape `http://username:pwd@proxy.company.com:8080`.
- The lab waits for mitmproxy to generate its CA, then proves that authenticated HTTPS through the proxy fails before that CA is trusted.
- The runner installs the mitmproxy CA into the container trust store, exports `NODE_USE_SYSTEM_CA=1`, `ALV_E2E_USE_SYSTEM_CA=1`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE`, and keeps VS Code `http.proxyStrictSSL` enabled.
- The lab verifies that `curl`, Node `fetch()`, and Salesforce CLI traffic can reach the internet/Salesforce through the authenticated MITM proxy after CA trust is installed.
- When `SF_DEVHUB_AUTH_URL` is present, the lab authenticates it inside the clean container as `ConfiguredDevHub` by default. Override this container-local alias with `ALV_E2E_PROXY_LAB_DEVHUB_ALIAS` for runs that need a different container-local alias.
- The lab sets `SFDX_DISABLE_DNS_CHECK=true` because the runner has no direct DNS/egress path to Salesforce; Salesforce CLI traffic must be validated through the proxy instead.
- `ALV_E2E_PROXY_LAB_PROXY_URL` can override the runner proxy URL for negative tests; by default it is `http://alv-proxy-user:alv-proxy-pass@proxy:8888`.
```

- [ ] **Step 3: Add CI behavior paragraph**

After the command examples in the same section, add:

```markdown
The standard GitHub Playwright E2E workflow runs both real-org surfaces through this MITM proxy lab. The CLI step populates the proxy-lab dependency volume, and the extension step reuses that volume with `ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1`. When telemetry validation is configured, Azure resource resolution and Log Analytics queries stay on the GitHub runner host while the Playwright child run executes inside the MITM proxy lab.
```

- [ ] **Step 4: Run docs-related script tests**

Run:

```bash
node --test scripts/docs-release.test.js scripts/cli-e2e-workflow.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

```bash
git add docs/TESTING.md
git commit -m "docs(testing): document mitm proxy e2e lab"
```

---

### Task 7: Run focused verification and container smoke

**Files:**
- No code edits unless a verification command exposes a bug. If a bug appears, stop and use `superpowers:systematic-debugging`.

- [ ] **Step 1: Run focused Node and Jest tests**

Run:

```bash
node --test scripts/run-e2e-proxy-lab.test.js scripts/run-playwright-e2e-telemetry.test.js scripts/cli-e2e-workflow.test.js
npm run test:e2e:utils
```

Expected:

```text
PASS / TAP success for all Node script tests
Test Suites: 8 passed, 8 total
Tests: 70 passed, 70 total
```

- [ ] **Step 2: Validate Compose syntax with Docker compatibility**

Run:

```bash
docker compose -f docker-compose.e2e-proxy.yml config --services
```

Expected output contains:

```text
proxy
runner
```

- [ ] **Step 3: Run a container smoke through the MITM trust flow**

Run:

```bash
ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1 npm run test:e2e:proxy-lab -- bash -lc 'echo proxy-lab-smoke'
```

Expected:

```text
[proxy-lab] Verifying authenticated HTTPS fails before trusting the MITM CA...
[proxy-lab] Installing mitmproxy CA into the runner trust store...
[proxy-lab] Verifying internet egress works through the authenticated MITM proxy...
proxy-lab-smoke
```

- [ ] **Step 4: Commit verification-only fixes when verification changed files**

If Step 1, 2, or 3 requires code fixes, commit them with:

```bash
git add docker-compose.e2e-proxy.yml test/e2e/proxy-lab/Dockerfile.proxy test/e2e/proxy-lab/run.sh scripts/run-e2e-proxy-lab.test.js
git commit -m "fix(e2e): stabilize mitm proxy lab smoke"
```

If verification did not change files, do not create a commit in this step.

---

### Task 8: Run real-org local validation

**Files:**
- No planned edits. If a real-org failure appears, stop and use `superpowers:systematic-debugging`.

- [ ] **Step 1: Resolve a Dev Hub auth URL for the clean container**

Run this without printing the secret:

```bash
export ALV_LOCAL_DEVHUB_AUTH_URL="$(
  sf org display --verbose -o "${SF_DEVHUB_ALIAS:-ConfiguredDevHub}" --json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const v=j.result && j.result.sfdxAuthUrl; if (!v) process.exit(2); process.stdout.write(v);})"
)"
test -n "${ALV_LOCAL_DEVHUB_AUTH_URL}"
```

Expected: command exits 0 and prints nothing.

- [ ] **Step 2: Run CLI real-org E2E through MITM proxy lab**

Run:

```bash
SF_DEVHUB_AUTH_URL="${ALV_LOCAL_DEVHUB_AUTH_URL}" \
SF_TEST_KEEP_ORG=1 \
npm run test:e2e:proxy-lab -- npm run test:e2e:cli
```

Expected: Playwright CLI E2E passes and shows the proxy-lab MITM trust checks before the suite starts.

- [ ] **Step 3: Run VS Code real-org E2E through MITM proxy lab**

Run:

```bash
SF_DEVHUB_AUTH_URL="${ALV_LOCAL_DEVHUB_AUTH_URL}" \
SF_TEST_KEEP_ORG=1 \
ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1 \
npm run test:e2e:proxy-lab -- npm run test:e2e
```

Expected: Playwright VS Code E2E passes and shows the proxy-lab MITM trust checks before the suite starts.

- [ ] **Step 4: Clear the local secret shell variable**

Run:

```bash
unset ALV_LOCAL_DEVHUB_AUTH_URL
```

Expected: command exits 0.

---

### Task 9: Final sweep before review

**Files:**
- Review all changed files.

- [ ] **Step 1: Check git status**

Run:

```bash
git status --short
```

Expected: no unexpected files. Expected changed files should already be committed, except any deliberate final edits.

- [ ] **Step 2: Run the relevant script suite**

Run:

```bash
npm run test:scripts
```

Expected: PASS. If this is too slow after all focused tests and real-org validation already passed, stop and ask before skipping it.

- [ ] **Step 3: Summarize verification evidence**

Prepare a concise summary with:

```text
- Focused tests run and result
- Docker Compose config result
- Proxy-lab smoke result
- Real-org CLI E2E result
- Real-org VS Code E2E result
- Any unrun verification and why
```

- [ ] **Step 4: Request code review**

Use `superpowers:requesting-code-review` before finalizing the substantial implementation.
