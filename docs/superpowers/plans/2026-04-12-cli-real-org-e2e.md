# CLI Real-Org E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-org E2E suite for the standalone `apex-log-viewer` binary covering `logs sync`, `logs status`, and `logs search`, and run it in GitHub Actions with the existing scratch-org `single` / `pool` contract.

**Architecture:** Reuse the existing TypeScript E2E helper stack for scratch-org lifecycle, seeding, and temporary workspaces, but add a CLI-specific Playwright runner that never launches VS Code or a browser. The new suite will execute the locally built standalone binary from the repo checkout, write artifacts under its own Playwright output root, and plug into the existing `.github/workflows/e2e-playwright.yml` workflow ahead of the extension suite.

**Tech Stack:** TypeScript, Node.js, `@playwright/test`, Jest/Node test runner, Salesforce CLI (`sf`), GitHub Actions, Cargo-built Rust CLI binary

---

## File Map

### New files

- `playwright.cli.config.ts`
  Purpose: dedicated Playwright config for CLI-only real-org E2E, isolated from the VS Code/Electron suite.
- `scripts/run-playwright-cli-e2e.js`
  Purpose: local/CI runner wrapper that ensures the standalone binary exists and then launches `@playwright/test` with the CLI config.
- `scripts/run-playwright-cli-e2e.test.js`
  Purpose: Node regression tests for the new runner and package-script contract.
- `test/e2e/cli/utils/cli.ts`
  Purpose: resolve the standalone binary path and execute CLI commands inside a temp workspace, capturing stdout/stderr/json.
- `test/e2e/cli/fixtures/alvCliE2E.ts`
  Purpose: worker-scoped scratch-org lease fixture and per-test workspace/seed/run helpers.
- `test/e2e/cli/specs/logs.e2e.spec.ts`
  Purpose: real-org CLI scenarios for `logs sync`, `logs status`, and `logs search`.
- `scripts/cli-e2e-workflow.test.js`
  Purpose: guard that the real-org GitHub Actions workflow runs the CLI suite and uploads its artifacts.

### Modified files

- `package.json`
  Purpose: expose `pretest:e2e:cli` and `test:e2e:cli`, and include the new Node tests in `test:scripts`.
- `.github/workflows/e2e-playwright.yml`
  Purpose: run the new CLI real-org suite before the extension E2E suite and upload separate CLI artifacts.
- `docs/TESTING.md`
  Purpose: document local execution, env vars, and artifact path for the standalone CLI E2E suite.
- `docs/CI.md`
  Purpose: document how the workflow now runs CLI real-org validation alongside the extension suite.

## Task 1: Add the CLI Playwright runner and npm entrypoints

**Files:**
- Create: `scripts/run-playwright-cli-e2e.test.js`
- Create: `scripts/run-playwright-cli-e2e.js`
- Create: `playwright.cli.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing runner test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureBuildArtifacts,
  findMissingBuildArtifacts,
  resolveCliBinaryRelativePath,
  resolveBuildInvocation
} = require('./run-playwright-cli-e2e');

function createTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alv-run-playwright-cli-e2e-'));
}

function cleanupTempRepo(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

test('resolveCliBinaryRelativePath targets the standalone cargo debug binary', () => {
  assert.equal(resolveCliBinaryRelativePath('linux'), 'target/debug/apex-log-viewer');
  assert.equal(resolveCliBinaryRelativePath('win32'), 'target/debug/apex-log-viewer.exe');
});

test('ensureBuildArtifacts runs npm run build:runtime when the CLI binary is missing', async () => {
  const repoRoot = createTempRepo();
  try {
    let recordedCall;

    await ensureBuildArtifacts(repoRoot, {
      spawnImpl(command, args, options) {
        recordedCall = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 0, null));
        return child;
      }
    });

    assert.ok(recordedCall);
    assert.equal(recordedCall.command, resolveBuildInvocation().command);
    assert.deepEqual(recordedCall.args, resolveBuildInvocation().args);
    assert.equal(recordedCall.options.cwd, repoRoot);
  } finally {
    cleanupTempRepo(repoRoot);
  }
});

test('package.json exposes the CLI E2E scripts', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['pretest:e2e:cli'], 'npm run build:runtime');
  assert.equal(packageJson.scripts['test:e2e:cli'], 'node scripts/run-playwright-cli-e2e.js');
  assert.match(packageJson.scripts['test:scripts'], /run-playwright-cli-e2e\\.test\\.js/);
});
```

- [ ] **Step 2: Run the runner test to verify it fails**

Run:

```bash
node --test scripts/run-playwright-cli-e2e.test.js
```

Expected:

- FAIL with `Cannot find module './run-playwright-cli-e2e'`
- The new `package.json` script assertions also fail because the scripts do not exist yet

- [ ] **Step 3: Write the minimal runner, config, and script wiring**

```js
// scripts/run-playwright-cli-e2e.js
#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

function resolveCliBinaryRelativePath(targetPlatform = process.platform) {
  return path.posix.join(
    'target',
    'debug',
    targetPlatform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer'
  );
}

const requiredBuildArtifacts = [resolveCliBinaryRelativePath()];

function exitWithChildResult(code, signal) {
  if (typeof code === 'number') {
    process.exit(code);
    return;
  }
  console.error(signal ? `[e2e:cli] Child exited via signal ${signal}` : '[e2e:cli] Child exited without code');
  process.exit(1);
}

function resolveBuildInvocation(targetPlatform = process.platform) {
  if (targetPlatform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:runtime']
    };
  }
  return { command: 'npm', args: ['run', 'build:runtime'] };
}

function findMissingBuildArtifacts(repoRoot) {
  return requiredBuildArtifacts.filter(relativePath => !existsSync(path.join(repoRoot, relativePath)));
}

function spawnAsync(command, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, options);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function ensureBuildArtifacts(repoRoot, options = {}) {
  const missingArtifacts = findMissingBuildArtifacts(repoRoot);
  if (!missingArtifacts.length) {
    return;
  }
  const buildInvocation = resolveBuildInvocation();
  const result = await spawnAsync(
    buildInvocation.command,
    buildInvocation.args,
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
    options.spawnImpl
  );
  if (result.code !== 0) {
    throw new Error(`npm run build:runtime failed while preparing CLI E2E (exit code ${result.code ?? 'unknown'}).`);
  }
}

function resolvePlaywrightInvocation(extraArgs) {
  const cliPath = require.resolve('@playwright/test/cli');
  return {
    command: process.execPath,
    args: [cliPath, 'test', '--config=playwright.cli.config.ts', ...extraArgs]
  };
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  await ensureBuildArtifacts(repoRoot);
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env
  });
  child.on('exit', exitWithChildResult);
}

if (require.main === module) {
  main().catch(error => {
    console.error('[e2e:cli] Failed to run Playwright CLI E2E:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  ensureBuildArtifacts,
  findMissingBuildArtifacts,
  requiredBuildArtifacts,
  resolveCliBinaryRelativePath,
  resolveBuildInvocation,
  resolvePlaywrightInvocation
};
```

```ts
// playwright.cli.config.ts
import path from 'path';
import { defineConfig } from '@playwright/test';

const repoRoot = __dirname;
const artifactsRoot = path.join(repoRoot, 'output', 'playwright-cli');
const resultsRoot = path.join(artifactsRoot, 'test-results');
const configuredWorkers = Math.max(1, Number(process.env.PLAYWRIGHT_WORKERS || 1) || 1);

export default defineConfig({
  testDir: path.join(__dirname, 'test', 'e2e', 'cli', 'specs'),
  fullyParallel: false,
  workers: configuredWorkers,
  timeout: 15 * 60 * 1000,
  expect: { timeout: 60 * 1000 },
  retries: process.env.CI ? 1 : 0,
  outputDir: resultsRoot,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(artifactsRoot, 'report') }]]
    : [['list']]
});
```

```json
// package.json (scripts excerpt)
{
  "scripts": {
    "test:scripts": "node --test scripts/run-node-tests.test.js scripts/run-tests-cli.test.js scripts/run-tests.test.js scripts/run-rust-tests.test.js scripts/run-vsce.test.js scripts/copy-runtime-binary.test.js scripts/copy-tree-sitter-runtime.test.js scripts/copy-package-metadata.test.js scripts/build-cli-npm-packages.test.js scripts/fetch-runtime-release.test.js scripts/publish-npm-package-if-needed.test.js scripts/packaging-ci.test.js scripts/repo-security.test.js scripts/check-dependency-sources.test.js scripts/docs-release.test.js scripts/deploy-azure-monitor.test.js scripts/azure-monitor-helpers.test.js scripts/eslint-type-aware.test.js scripts/run-playwright-e2e.test.js scripts/run-playwright-cli-e2e.test.js scripts/run-playwright-e2e-telemetry.test.js scripts/resolve-vscode-cache-metadata.test.js scripts/scratch-pool-admin.test.js && node scripts/check-dependency-sources.mjs",
    "pretest:e2e:cli": "npm run build:runtime",
    "test:e2e:cli": "node scripts/run-playwright-cli-e2e.js"
  }
}
```

- [ ] **Step 4: Run the runner test to verify it passes**

Run:

```bash
node --test scripts/run-playwright-cli-e2e.test.js
```

Expected:

- PASS
- The assertions confirm the new runner builds `target/debug/apex-log-viewer` through `npm run build:runtime`

- [ ] **Step 5: Commit**

```bash
git add package.json playwright.cli.config.ts scripts/run-playwright-cli-e2e.js scripts/run-playwright-cli-e2e.test.js
git commit -m "test(cli): add playwright runner for real-org e2e"
```

## Task 2: Add the CLI fixture and make `logs sync` pass against a real scratch org

**Files:**
- Create: `test/e2e/cli/utils/cli.ts`
- Create: `test/e2e/cli/fixtures/alvCliE2E.ts`
- Create: `test/e2e/cli/specs/logs.e2e.spec.ts`
- Reuse: `test/e2e/utils/scratchOrg.ts`
- Reuse: `test/e2e/utils/seedLog.ts`
- Reuse: `test/e2e/utils/tempWorkspace.ts`

- [ ] **Step 1: Write the failing `logs sync` E2E spec**

```ts
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '../fixtures/alvCliE2E';

test('logs sync --json downloads the seeded Apex log into the workspace cache', async ({
  scratchAlias,
  workspacePath,
  seededLog,
  runCli
}) => {
  const result = await runCli(['logs', 'sync', '--json', '--target-org', scratchAlias]);

  expect(result.exitCode).toBe(0);
  expect(result.json?.status).toBe('success');
  expect(result.json?.downloaded).toBeGreaterThanOrEqual(1);
  expect(result.json?.last_synced_log_id).toBeTruthy();
  expect(result.json?.target_org).toContain('@');
  expect(seededLog.marker.startsWith('ALV_E2E_MARKER_')).toBe(true);

  await expect(stat(path.join(workspacePath, 'apexlogs', '.alv', 'sync-state.json'))).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run the `logs sync` spec to verify it fails**

Run:

```bash
SF_TEST_KEEP_ORG=1 PLAYWRIGHT_WORKERS=1 npm run test:e2e:cli -- --grep "logs sync --json downloads the seeded Apex log into the workspace cache"
```

Expected:

- FAIL with `Cannot find module '../fixtures/alvCliE2E'`
- No CLI code should be written until this failing test is observed

- [ ] **Step 3: Write the minimal CLI helper and fixture**

```ts
// test/e2e/cli/utils/cli.ts
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { timeE2eStep } from '../../utils/timing';

export type CliRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: any;
};

function repoRoot(): string {
  return path.join(__dirname, '..', '..', '..', '..');
}

export function resolveCliBinaryPath(baseDir = repoRoot()): string {
  return path.join(baseDir, 'target', 'debug', process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer');
}

export async function runCliCommand(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<CliRunResult> {
  const binaryPath = resolveCliBinaryPath();
  await access(binaryPath);

  return await timeE2eStep(`cli.run:${args.join(' ')}`, async () => {
    return await new Promise((resolve, reject) => {
      execFile(binaryPath, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 0;
        const trimmed = String(stdout || '').trim();
        let json;
        if (trimmed) {
          try {
            json = JSON.parse(trimmed);
          } catch {
            json = undefined;
          }
        }
        if (error && typeof exitCode !== 'number') {
          reject(error);
          return;
        }
        resolve({
          exitCode,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          json
        });
      });
    });
  });
}
```

```ts
// test/e2e/cli/fixtures/alvCliE2E.ts
import { test as base, expect } from '@playwright/test';
import { clearOrgApexLogs, seedApexLog } from '../../utils/seedLog';
import { ensureScratchOrg } from '../../utils/scratchOrg';
import { createTempWorkspace } from '../../utils/tempWorkspace';
import { runCliCommand, type CliRunResult } from '../utils/cli';

type SeededLog = { marker: string; logId: string };
type ScratchLeaseState = {
  scratch: Awaited<ReturnType<typeof ensureScratchOrg>>;
  hadFailure: boolean;
  failureMessage?: string;
};

type Fixtures = {
  scratchAlias: string;
  workspacePath: string;
  seededLog: SeededLog;
  runCli: (args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<CliRunResult>;
  scratchLeaseState: ScratchLeaseState;
};

export const test = base.extend<Fixtures>({
  scratchLeaseState: [
    async ({}, use) => {
      const scratch = await ensureScratchOrg();
      const state: ScratchLeaseState = { scratch, hadFailure: false };
      try {
        await use(state);
      } finally {
        await scratch.cleanup({
          success: !state.hadFailure,
          needsRecreate: state.hadFailure,
          errorMessage: state.failureMessage,
          lastRunResult: state.hadFailure ? 'failed' : 'completed'
        });
      }
    },
    { scope: 'worker' }
  ],

  _scratchLeaseGuard: [
    async ({ scratchLeaseState }, use, testInfo) => {
      scratchLeaseState.scratch.assertLeaseHealthy?.();
      await use();
      if (testInfo.status !== testInfo.expectedStatus) {
        scratchLeaseState.hadFailure = true;
        scratchLeaseState.failureMessage ??= `Test '${testInfo.title}' ended with status '${testInfo.status}'.`;
      }
      scratchLeaseState.scratch.assertLeaseHealthy?.();
    },
    { auto: true }
  ],

  scratchAlias: [
    async ({ scratchLeaseState }, use) => {
      await use(scratchLeaseState.scratch.scratchAlias);
    },
    { scope: 'worker' }
  ],

  workspacePath: async ({ scratchAlias }, use, testInfo) => {
    const workspace = await createTempWorkspace({ targetOrg: scratchAlias });
    try {
      await use(workspace.workspacePath);
    } finally {
      await workspace.cleanup({ keep: testInfo.status !== testInfo.expectedStatus });
    }
  },

  seededLog: async ({ scratchAlias }, use) => {
    await clearOrgApexLogs(scratchAlias);
    const seeded = await seedApexLog(scratchAlias);
    await use(seeded);
  },

  runCli: async ({ workspacePath }, use, testInfo) => {
    await use(async (args, options = {}) => {
      const result = await runCliCommand(args, { cwd: workspacePath, env: options.env });
      await testInfo.attach('cli-stdout.txt', {
        body: Buffer.from(result.stdout, 'utf8'),
        contentType: 'text/plain'
      });
      await testInfo.attach('cli-stderr.txt', {
        body: Buffer.from(result.stderr, 'utf8'),
        contentType: 'text/plain'
      });
      return result;
    });
  }
});

export { expect };
```

- [ ] **Step 4: Run the `logs sync` spec to verify it passes**

Run:

```bash
SF_TEST_KEEP_ORG=1 PLAYWRIGHT_WORKERS=1 npm run test:e2e:cli -- --grep "logs sync --json downloads the seeded Apex log into the workspace cache"
```

Expected:

- PASS
- The CLI writes `apexlogs/.alv/sync-state.json` inside the temp workspace
- The Playwright output root is `output/playwright-cli/`

- [ ] **Step 5: Commit**

```bash
git add test/e2e/cli/utils/cli.ts test/e2e/cli/fixtures/alvCliE2E.ts test/e2e/cli/specs/logs.e2e.spec.ts
git commit -m "test(cli): add real-org sync e2e fixture"
```

## Task 3: Add `logs status` and `logs search` real-org coverage

**Files:**
- Modify: `test/e2e/cli/fixtures/alvCliE2E.ts`
- Modify: `test/e2e/cli/specs/logs.e2e.spec.ts`

- [ ] **Step 1: Write the failing `status` and `search` tests**

```ts
// test/e2e/cli/specs/logs.e2e.spec.ts
test('logs status --json reports sync metadata for the seeded scratch org', async ({
  scratchAlias,
  syncLogs,
  runCli
}) => {
  const sync = await syncLogs();
  const status = await runCli(['logs', 'status', '--json', '--target-org', scratchAlias]);

  expect(status.exitCode).toBe(0);
  expect(status.json?.has_state).toBe(true);
  expect(status.json?.downloaded_count).toBeGreaterThanOrEqual(sync.downloaded);
  expect(status.json?.last_synced_log_id).toBe(sync.last_synced_log_id);
  expect(status.json?.log_count).toBeGreaterThanOrEqual(1);
});

test('logs search --json finds the seeded marker locally after sync', async ({
  scratchAlias,
  seededLog,
  syncLogs,
  runCli
}) => {
  await syncLogs();
  const search = await runCli(['logs', 'search', seededLog.marker, '--json', '--target-org', scratchAlias]);

  expect(search.exitCode).toBe(0);
  expect(search.json?.query).toBe(seededLog.marker);
  expect(Array.isArray(search.json?.matches)).toBe(true);
  expect(search.json?.matches.some((match: { log_id: string }) => match.log_id === seededLog.logId)).toBe(true);
  expect(search.json?.pending_log_ids).toEqual([]);
});
```

- [ ] **Step 2: Run the targeted CLI spec to verify it fails**

Run:

```bash
SF_TEST_KEEP_ORG=1 PLAYWRIGHT_WORKERS=1 npm run test:e2e:cli -- --grep "logs status --json|logs search --json"
```

Expected:

- FAIL because `syncLogs` is not defined in the fixture contract yet

- [ ] **Step 3: Add the minimal `syncLogs` fixture helper**

```ts
// test/e2e/cli/fixtures/alvCliE2E.ts (type + fixture excerpt)
type Fixtures = {
  scratchAlias: string;
  workspacePath: string;
  seededLog: SeededLog;
  runCli: (args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<CliRunResult>;
  syncLogs: () => Promise<any>;
  scratchLeaseState: ScratchLeaseState;
};

syncLogs: async ({ scratchAlias, runCli }, use) => {
  await use(async () => {
    const result = await runCli(['logs', 'sync', '--json', '--target-org', scratchAlias]);
    expect(result.exitCode).toBe(0);
    expect(result.json?.status).toBe('success');
    return result.json;
  });
}
```

- [ ] **Step 4: Run the full CLI E2E suite to verify all three scenarios pass**

Run:

```bash
SF_TEST_KEEP_ORG=1 PLAYWRIGHT_WORKERS=1 npm run test:e2e:cli
```

Expected:

- PASS
- 3 passing tests:
  - `logs sync --json downloads the seeded Apex log into the workspace cache`
  - `logs status --json reports sync metadata for the seeded scratch org`
  - `logs search --json finds the seeded marker locally after sync`

- [ ] **Step 5: Commit**

```bash
git add test/e2e/cli/fixtures/alvCliE2E.ts test/e2e/cli/specs/logs.e2e.spec.ts
git commit -m "test(cli): cover status and search real-org flows"
```

## Task 4: Wire the CLI suite into the real-org GitHub Actions workflow

**Files:**
- Create: `scripts/cli-e2e-workflow.test.js`
- Modify: `package.json`
- Modify: `.github/workflows/e2e-playwright.yml`

- [ ] **Step 1: Write the failing workflow guard test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

function readWorkflow() {
  return YAML.parse(
    fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'e2e-playwright.yml'), 'utf8')
  );
}

test('test:scripts covers the CLI workflow guard', () => {
  const packageJson = readPackageJson();
  assert.match(packageJson.scripts['test:scripts'], /cli-e2e-workflow\\.test\\.js/);
});

test('real-org workflow runs the CLI suite and uploads its artifacts', () => {
  const workflow = readWorkflow();
  const steps = workflow.jobs.playwright_e2e.steps;

  const cliStep = steps.find(step => step.name === 'Run CLI real-org E2E');
  assert.ok(cliStep);
  assert.match(cliStep.run, /npm run test:e2e:cli/);

  const artifactStep = steps.find(step => step.name === 'Upload CLI E2E artifacts');
  assert.ok(artifactStep);
  assert.equal(artifactStep.with.path, 'output/playwright-cli/');
});
```

- [ ] **Step 2: Run the workflow guard test to verify it fails**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected:

- FAIL because the file is new and the workflow still lacks the CLI step/artifact upload

- [ ] **Step 3: Add the minimal workflow integration**

```yaml
# .github/workflows/e2e-playwright.yml (step excerpt)
- name: Run CLI real-org E2E
  shell: bash
  run: |
    echo "Scratch strategy: ${SCRATCH_STRATEGY}"
    npm run test:e2e:cli
  env:
    PLAYWRIGHT_WORKERS: ${{ env.PLAYWRIGHT_WORKERS }}
    SF_SCRATCH_STRATEGY: ${{ env.SCRATCH_STRATEGY }}
    SF_SCRATCH_POOL_NAME: ${{ env.SCRATCH_POOL_NAME }}
    SF_SCRATCH_POOL_OWNER: github:${{ github.run_id }}/${{ github.run_attempt }}
    SF_SCRATCH_POOL_LEASE_TTL_SECONDS: ${{ vars.SF_SCRATCH_POOL_LEASE_TTL_SECONDS }}
    SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS: ${{ vars.SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS }}
    SF_SCRATCH_POOL_HEARTBEAT_SECONDS: ${{ vars.SF_SCRATCH_POOL_HEARTBEAT_SECONDS }}
    SF_SCRATCH_POOL_MIN_REMAINING_MINUTES: ${{ vars.SF_SCRATCH_POOL_MIN_REMAINING_MINUTES }}
    SF_SCRATCH_POOL_SEED_VERSION: ${{ vars.SF_SCRATCH_POOL_SEED_VERSION }}
    SF_SCRATCH_POOL_SNAPSHOT_NAME: ${{ vars.SF_SCRATCH_POOL_SNAPSHOT_NAME }}
    SF_DEVHUB_AUTH_URL: ${{ secrets.SF_DEVHUB_AUTH_URL }}
    SF_DEVHUB_ALIAS: DevHubElectivus
    SF_SCRATCH_DURATION: ${{ github.event.inputs.scratch_duration_days || '1' }}
    SF_TEST_KEEP_ORG: '1'

- name: Upload CLI E2E artifacts
  if: ${{ !cancelled() }}
  uses: actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f
  with:
    name: playwright-cli-e2e
    path: output/playwright-cli/
    if-no-files-found: ignore
```

```json
// package.json (scripts excerpt)
{
  "scripts": {
    "test:scripts": "node --test scripts/run-node-tests.test.js scripts/run-tests-cli.test.js scripts/run-tests.test.js scripts/run-rust-tests.test.js scripts/run-vsce.test.js scripts/copy-runtime-binary.test.js scripts/copy-tree-sitter-runtime.test.js scripts/copy-package-metadata.test.js scripts/build-cli-npm-packages.test.js scripts/fetch-runtime-release.test.js scripts/publish-npm-package-if-needed.test.js scripts/packaging-ci.test.js scripts/repo-security.test.js scripts/check-dependency-sources.test.js scripts/docs-release.test.js scripts/deploy-azure-monitor.test.js scripts/azure-monitor-helpers.test.js scripts/eslint-type-aware.test.js scripts/run-playwright-e2e.test.js scripts/run-playwright-cli-e2e.test.js scripts/run-playwright-e2e-telemetry.test.js scripts/resolve-vscode-cache-metadata.test.js scripts/scratch-pool-admin.test.js scripts/cli-e2e-workflow.test.js && node scripts/check-dependency-sources.mjs"
  }
}
```

- [ ] **Step 4: Run the workflow guard test to verify it passes**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected:

- PASS
- The parsed workflow contains a CLI step before the extension Playwright step and uploads `output/playwright-cli/`

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/e2e-playwright.yml scripts/cli-e2e-workflow.test.js
git commit -m "ci: run cli real-org e2e in workflow"
```

## Task 5: Document the new suite and run final verification

**Files:**
- Modify: `docs/TESTING.md`
- Modify: `docs/CI.md`

- [ ] **Step 1: Confirm the docs do not already mention the CLI suite**

Run:

```bash
rg -n "test:e2e:cli|output/playwright-cli|Run CLI real-org E2E" docs/TESTING.md docs/CI.md
```

Expected:

- No matches before the documentation update

- [ ] **Step 2: Add the minimal docs update**

```md
<!-- docs/TESTING.md excerpt -->
- `npm run test:e2e:cli`: runs Playwright-managed real-org E2E tests for the standalone `apex-log-viewer` binary. This suite provisions scratch orgs through the same `single` / `pool` helper used by the VS Code E2E flow, but never launches VS Code or Electron.

### CLI Playwright E2E (real org)

From the repo root:

- `SF_TEST_KEEP_ORG=1 npm run test:e2e:cli`

Useful env vars:

- `SF_DEVHUB_AUTH_URL`
- `SF_DEVHUB_ALIAS`
- `SF_SCRATCH_STRATEGY`
- `SF_SCRATCH_POOL_NAME`
- `PLAYWRIGHT_WORKERS`
- `SF_SCRATCH_DURATION`
- `SF_TEST_KEEP_ORG=1`

Artifacts (stdout/stderr attachments and Playwright report output on failure) are written under `output/playwright-cli/`.
```

```md
<!-- docs/CI.md excerpt -->
- Workflow E2E (`.github/workflows/e2e-playwright.yml`): real scratch-org validation now runs two surfaces in the same workflow:
  - `npm run test:e2e:cli` for the standalone `apex-log-viewer` binary
  - `npm run test:e2e` / `npm run test:e2e:telemetry` for the VS Code extension flow

- The workflow uploads CLI artifacts from `output/playwright-cli/` and extension artifacts from `output/playwright/`.
```

- [ ] **Step 3: Run verification**

Run:

```bash
node --test scripts/run-playwright-cli-e2e.test.js scripts/cli-e2e-workflow.test.js
```

Expected:

- PASS

Run:

```bash
npm run test:scripts
```

Expected:

- PASS, including the new CLI runner/workflow tests

Run:

```bash
SF_TEST_KEEP_ORG=1 PLAYWRIGHT_WORKERS=1 npm run test:e2e:cli
```

Expected:

- PASS with all three CLI real-org scenarios green

- [ ] **Step 4: Commit**

```bash
git add docs/TESTING.md docs/CI.md
git commit -m "docs: document cli real-org e2e"
```

## Self-Review Checklist

- Spec coverage:
  - standalone CLI real-org suite: covered by Tasks 2 and 3
  - `logs sync`, `logs status`, `logs search`: covered by Tasks 2 and 3
  - shared `single` / `pool` scratch-org model: covered by Task 2 fixture reuse and Task 4 CI env reuse
  - GitHub Actions integration: covered by Task 4
  - local/CI docs: covered by Task 5
- Placeholder scan:
  - no `TBD`, `TODO`, `implement later`, or “similar to Task N”
  - every code step includes explicit file content or excerpts
- Type consistency:
  - fixture names are consistent across tasks: `scratchAlias`, `workspacePath`, `seededLog`, `runCli`, `syncLogs`
  - runner names are consistent across tasks: `resolveCliBinaryRelativePath`, `resolveBuildInvocation`, `ensureBuildArtifacts`
