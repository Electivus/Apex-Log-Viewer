# CLI E2E Cargo Target Dir Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CLI Playwright E2E locate the standalone debug CLI binary from Cargo's effective target directory.

**Architecture:** The Node E2E wrapper resolves Cargo's `target_directory`, checks that directory plus the legacy `target/debug` path, and passes the selected binary path to Playwright through `ALV_CLI_BINARY_PATH`. The TypeScript CLI test helper treats that env var as an explicit binary override and keeps its current fallback behavior when the env var is absent.

**Tech Stack:** Node.js CommonJS test runner, Playwright TypeScript helpers, Cargo metadata.

---

## File structure

- Modify `scripts/run-playwright-cli-e2e.js`
  - Resolve Cargo target-dir candidates.
  - Return the selected CLI binary path from `ensureBuildArtifacts()`.
  - Pass `ALV_CLI_BINARY_PATH` into the Playwright child process.
- Modify `scripts/run-playwright-cli-e2e.test.js`
  - Add focused tests for Cargo target-dir discovery and env propagation.
  - Adjust existing tests only when needed for the returned binary path.
- Modify `test/e2e/cli/utils/cli.ts`
  - Prefer `ALV_CLI_BINARY_PATH` when present.
  - Fail clearly if the explicit env path is missing.
  - Preserve legacy fallback and Windows command shim behavior.
- Modify `test/e2e/cli/specs/cliHelper.e2e.spec.ts`
  - Add helper tests for the env-var override success and missing-path diagnostics.

## Task 1: Add failing tests for the E2E wrapper target-dir lookup

**Files:**
- Modify: `scripts/run-playwright-cli-e2e.test.js`
- Test target: `scripts/run-playwright-cli-e2e.js`

- [ ] **Step 1: Add a helper for fake Cargo metadata responses**

Insert this helper after `readPackageScripts()`:

```js
function cargoMetadataSpawnSync(cargoTargetDir) {
  return function spawnSyncImpl(command, args, options) {
    assert.equal(command, 'cargo');
    assert.deepEqual(args, ['metadata', '--format-version=1', '--no-deps']);
    assert.equal(options.encoding, 'utf8');

    return {
      status: 0,
      stdout: JSON.stringify({ target_directory: cargoTargetDir })
    };
  };
}
```

- [ ] **Step 2: Add a failing test for configured Cargo target-dir discovery**

Insert this test after `findMissingBuildArtifacts still requires the host debug binary when CARGO_BUILD_TARGET is set`:

```js
test('findMissingBuildArtifacts accepts the debug CLI binary from Cargo target_directory', () => {
  const repoRoot = createTempRepo();
  const cargoTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cargo-target-'));
  try {
    const runner = loadRunner();
    const cliBinaryName = path.basename(runner.resolveCliBinaryRelativePath(process.platform));
    const cliBinaryPath = path.join(cargoTargetDir, 'debug', cliBinaryName);
    fs.mkdirSync(path.dirname(cliBinaryPath), { recursive: true });
    fs.writeFileSync(cliBinaryPath, '', 'utf8');

    assert.deepEqual(
      runner.findMissingBuildArtifacts(repoRoot, {
        spawnSyncImpl: cargoMetadataSpawnSync(cargoTargetDir)
      }),
      []
    );
    assert.equal(
      runner.resolveBuiltCliBinaryPath(repoRoot, {
        spawnSyncImpl: cargoMetadataSpawnSync(cargoTargetDir)
      }),
      cliBinaryPath
    );
  } finally {
    cleanupTempRepo(repoRoot);
    fs.rmSync(cargoTargetDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Add a failing test for build preparation returning the target-dir binary**

Insert this test after `ensureBuildArtifacts runs npm run build:runtime when the CLI binary is missing`:

```js
test('ensureBuildArtifacts returns the configured Cargo target-dir CLI binary after building', async () => {
  const repoRoot = createTempRepo();
  const cargoTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cargo-target-'));
  try {
    const runner = loadRunner();
    const cliBinaryName = path.basename(runner.resolveCliBinaryRelativePath(process.platform));
    const cliBinaryPath = path.join(cargoTargetDir, 'debug', cliBinaryName);
    let recordedCall;

    const result = await runner.ensureBuildArtifacts(repoRoot, {
      spawnSyncImpl: cargoMetadataSpawnSync(cargoTargetDir),
      spawnImpl(command, args, options) {
        recordedCall = { command, args, options };
        const child = new EventEmitter();
        process.nextTick(() => {
          fs.mkdirSync(path.dirname(cliBinaryPath), { recursive: true });
          fs.writeFileSync(cliBinaryPath, '', 'utf8');
          child.emit('exit', 0, null);
        });
        return child;
      }
    });

    assert.ok(recordedCall, 'expected ensureBuildArtifacts to invoke the build command');
    assert.equal(result, cliBinaryPath);
  } finally {
    cleanupTempRepo(repoRoot);
    fs.rmSync(cargoTargetDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Add a failing test for Playwright env propagation**

Insert this test near the `resolvePlaywrightInvocation` tests:

```js
test('resolvePlaywrightEnv passes the selected CLI binary path to Playwright', () => {
  const runner = loadRunner();
  const env = runner.resolvePlaywrightEnv('/tmp/alv/bin/apex-log-viewer', { EXISTING: '1' });

  assert.equal(env.EXISTING, '1');
  assert.equal(env.ALV_CLI_BINARY_PATH, '/tmp/alv/bin/apex-log-viewer');
});
```

- [ ] **Step 5: Run the focused tests and verify they fail for missing exports/behavior**

Run:

```bash
node --test scripts/run-playwright-cli-e2e.test.js
```

Expected: FAIL with messages mentioning `resolveBuiltCliBinaryPath` or `resolvePlaywrightEnv` is not a function, or failing target-dir assertions.

## Task 2: Implement the E2E wrapper target-dir lookup

**Files:**
- Modify: `scripts/run-playwright-cli-e2e.js`
- Test: `scripts/run-playwright-cli-e2e.test.js`

- [ ] **Step 1: Import `spawnSync` and add binary/candidate helpers**

Change the first import and add these functions after `resolveCliBinaryRelativePath()`:

```js
const { spawn, spawnSync } = require('child_process');
```

```js
function resolveCliBinaryName(targetPlatform = process.platform) {
  return targetPlatform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

function normalizeCargoTargetDirectory(repoRoot, cargoTargetDirectory) {
  if (!cargoTargetDirectory) {
    return undefined;
  }
  return path.isAbsolute(cargoTargetDirectory)
    ? cargoTargetDirectory
    : path.resolve(repoRoot, cargoTargetDirectory);
}

function resolveCargoTargetDirectory(repoRoot, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl('cargo', ['metadata', '--format-version=1', '--no-deps'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  try {
    const metadata = JSON.parse(result.stdout || '{}');
    return normalizeCargoTargetDirectory(repoRoot, metadata.target_directory);
  } catch {
    return undefined;
  }
}

function displayCandidatePath(repoRoot, candidatePath) {
  const relativePath = path.relative(repoRoot, candidatePath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath
    : candidatePath;
}

function resolveCliBinaryCandidatePaths(repoRoot, options = {}) {
  const targetPlatform = options.targetPlatform || process.platform;
  const binaryName = resolveCliBinaryName(targetPlatform);
  const cargoTargetDirectory =
    options.cargoTargetDirectory === undefined
      ? resolveCargoTargetDirectory(repoRoot, options)
      : normalizeCargoTargetDirectory(repoRoot, options.cargoTargetDirectory);
  const candidates = [];

  if (cargoTargetDirectory) {
    candidates.push(path.join(cargoTargetDirectory, 'debug', binaryName));
  }

  candidates.push(path.join(repoRoot, resolveCliBinaryRelativePath(targetPlatform)));
  return [...new Set(candidates)];
}

function resolveBuiltCliBinaryPath(repoRoot, options = {}) {
  return resolveCliBinaryCandidatePaths(repoRoot, options).find(candidate => existsSync(candidate));
}
```

- [ ] **Step 2: Replace accepted-path and missing-artifact logic**

Replace `resolveAcceptedCliBinaryRelativePaths()` and `findMissingBuildArtifacts()` with:

```js
function resolveAcceptedCliBinaryRelativePaths(targetPlatform = process.platform) {
  return [resolveCliBinaryRelativePath(targetPlatform)];
}

function findMissingBuildArtifacts(repoRoot, options = {}) {
  if (resolveBuiltCliBinaryPath(repoRoot, options)) {
    return [];
  }

  return [
    resolveCliBinaryCandidatePaths(repoRoot, options)
      .map(candidate => displayCandidatePath(repoRoot, candidate))
      .join(' or ')
  ];
}
```

- [ ] **Step 3: Return the selected binary from `ensureBuildArtifacts()`**

Replace `ensureBuildArtifacts()` with:

```js
async function ensureBuildArtifacts(repoRoot, options = {}) {
  const existingCliBinaryPath = resolveBuiltCliBinaryPath(repoRoot, options);
  if (existingCliBinaryPath) {
    return existingCliBinaryPath;
  }

  const missingArtifacts = findMissingBuildArtifacts(repoRoot, options);
  console.log(
    `[e2e:cli] Missing build artifacts (${missingArtifacts.join(', ')}). Running npm run build:runtime before Playwright...`
  );
  const buildInvocation = resolveBuildInvocation();
  const buildEnv = { ...process.env };
  delete buildEnv.CARGO_BUILD_TARGET;
  const result = await spawnAsync(
    buildInvocation.command,
    buildInvocation.args,
    { cwd: repoRoot, env: buildEnv, stdio: 'inherit' },
    options.spawnImpl
  );

  if (result.code !== 0) {
    const details =
      typeof result.code === 'number' ? `exit code ${result.code}` : `signal ${result.signal || 'unknown'}`;
    throw new Error(`npm run build:runtime failed while preparing CLI Playwright E2E (${details}).`);
  }

  const builtCliBinaryPath = resolveBuiltCliBinaryPath(repoRoot, options);
  if (!builtCliBinaryPath) {
    const remainingMissingArtifacts = findMissingBuildArtifacts(repoRoot, options);
    throw new Error(
      `npm run build:runtime did not produce required CLI artifact(s): ${remainingMissingArtifacts.join(', ')}.`
    );
  }
  return builtCliBinaryPath;
}
```

- [ ] **Step 4: Add Playwright env propagation**

Add this helper before `main()`:

```js
function resolvePlaywrightEnv(cliBinaryPath, env = process.env) {
  return {
    ...env,
    ALV_CLI_BINARY_PATH: cliBinaryPath
  };
}
```

Then replace the start of `main()` and the child `env` option with:

```js
async function main() {
  const repoRoot = path.join(__dirname, '..');
  const cliBinaryPath = await ensureBuildArtifacts(repoRoot);
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: resolvePlaywrightEnv(cliBinaryPath)
  });
  child.on('exit', exitWithChildResult);
}
```

- [ ] **Step 5: Export the new helper functions**

Add these properties to `module.exports`:

```js
  resolveBuiltCliBinaryPath,
  resolveCargoTargetDirectory,
  resolveCliBinaryCandidatePaths,
  resolvePlaywrightEnv
```

- [ ] **Step 6: Run the focused tests and verify Task 1 now passes**

Run:

```bash
node --test scripts/run-playwright-cli-e2e.test.js
```

Expected: PASS for all tests in `scripts/run-playwright-cli-e2e.test.js`.

- [ ] **Step 7: Commit Task 1 and Task 2**

Run:

```bash
git add scripts/run-playwright-cli-e2e.js scripts/run-playwright-cli-e2e.test.js
git commit -m "fix(e2e): resolve CLI binary from Cargo target dir"
```

## Task 3: Add failing tests for the CLI helper env override

**Files:**
- Modify: `test/e2e/cli/specs/cliHelper.e2e.spec.ts`
- Test target: `test/e2e/cli/utils/cli.ts`

- [ ] **Step 1: Add an explicit binary helper**

Insert this helper after `writeFakeStandaloneBinary()`:

```ts
async function writeFakeStandaloneBinaryAtPath(binaryPath: string, scriptBody: string): Promise<string> {
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, scriptBody, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(binaryPath, 0o755);
  }
  return binaryPath;
}
```

- [ ] **Step 2: Add a failing env-var success test**

Insert this test after `resolveAlvCliBinaryPath rejects extension runtime fallback when standalone binary is missing`:

```ts
test('resolveAlvCliBinaryPath prefers ALV_CLI_BINARY_PATH when it exists', async () => {
  await withTempRepo(async repoRoot => {
    const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
    const configuredBinaryPath = await writeFakeStandaloneBinaryAtPath(
      path.join(repoRoot, '..', '.cargo-target', 'Apex-Log-Viewer', 'debug', binaryName),
      '#!/bin/sh\nexit 0\n'
    );

    const env = { ALV_CLI_BINARY_PATH: configuredBinaryPath };

    expect(resolveAlvCliBinaryPath({ repoRoot, env })).toBe(configuredBinaryPath);
    expect(resolveAlvCliInvocation({ repoRoot, env })).toEqual({
      command: configuredBinaryPath,
      args: []
    });
  });
});
```

- [ ] **Step 3: Add a failing missing explicit path test**

Insert this test after the env-var success test:

```ts
test('resolveAlvCliBinaryPath fails clearly when ALV_CLI_BINARY_PATH is missing', async () => {
  await withTempRepo(async repoRoot => {
    const binaryName = process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
    const missingBinaryPath = path.join(repoRoot, '..', '.cargo-target', 'Apex-Log-Viewer', 'debug', binaryName);
    await writeFakeStandaloneBinary(repoRoot, '#!/bin/sh\nexit 0\n');

    expect(() =>
      resolveAlvCliBinaryPath({
        repoRoot,
        env: { ALV_CLI_BINARY_PATH: missingBinaryPath }
      })
    ).toThrow(/ALV_CLI_BINARY_PATH/);
    expect(() =>
      resolveAlvCliInvocation({
        repoRoot,
        env: { ALV_CLI_BINARY_PATH: missingBinaryPath }
      })
    ).toThrow(/ALV_CLI_BINARY_PATH/);
  });
});
```

- [ ] **Step 4: Run the CLI helper tests and verify they fail for unsupported options**

Run:

```bash
npx playwright test test/e2e/cli/specs/cliHelper.e2e.spec.ts --config=playwright.cli.config.ts
```

Expected: FAIL because `ResolveAlvCliBinaryPathOptions` does not yet accept `env`, or because the helper ignores `ALV_CLI_BINARY_PATH`.

## Task 4: Implement CLI helper env override

**Files:**
- Modify: `test/e2e/cli/utils/cli.ts`
- Test: `test/e2e/cli/specs/cliHelper.e2e.spec.ts`

- [ ] **Step 1: Add `env` to the resolver option type**

Replace `ResolveAlvCliBinaryPathOptions` with:

```ts
type ResolveAlvCliBinaryPathOptions = {
  repoRoot?: string;
  cargoBuildTarget?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};
```

- [ ] **Step 2: Add explicit env-var helpers**

Insert these functions after `resolveBinaryCandidates()`:

```ts
function resolveConfiguredCliBinaryPath(options: ResolveAlvCliBinaryPathOptions = {}): string | undefined {
  const rawPath = String((options.env ?? process.env).ALV_CLI_BINARY_PATH ?? '').trim();
  if (!rawPath) {
    return undefined;
  }

  const repoRoot = options.repoRoot || resolveRepoRoot();
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

function formatMissingBinaryMessage(
  configuredBinaryPath: string | undefined,
  fallbackCandidates: string[]
): string {
  if (configuredBinaryPath) {
    return `Unable to locate apex-log-viewer standalone binary from ALV_CLI_BINARY_PATH. Checked: ${[
      configuredBinaryPath,
      ...fallbackCandidates
    ].join(', ')}`;
  }

  return `Unable to locate apex-log-viewer standalone binary. Checked: ${fallbackCandidates.join(', ')}`;
}
```

- [ ] **Step 3: Update `resolveAlvCliBinaryPath()`**

Replace the function body with:

```ts
export function resolveAlvCliBinaryPath(options: ResolveAlvCliBinaryPathOptions = {}): string {
  const configuredBinaryPath = resolveConfiguredCliBinaryPath(options);
  const candidates = resolveBinaryCandidates(options);

  if (configuredBinaryPath) {
    if (existsSync(configuredBinaryPath)) {
      return configuredBinaryPath;
    }
    throw new Error(formatMissingBinaryMessage(configuredBinaryPath, candidates));
  }

  const binaryPath = candidates.find(candidate => existsSync(candidate));
  if (!binaryPath) {
    throw new Error(formatMissingBinaryMessage(undefined, candidates));
  }
  return binaryPath;
}
```

- [ ] **Step 4: Update `resolveAlvCliInvocation()`**

Replace the first part of the function with this code, keeping the Windows command-shim fallback after it:

```ts
export function resolveAlvCliInvocation(options: ResolveAlvCliInvocationOptions = {}): CliInvocation {
  const configuredBinaryPath = resolveConfiguredCliBinaryPath(options);
  const candidates = resolveBinaryCandidates(options);

  if (configuredBinaryPath) {
    if (existsSync(configuredBinaryPath)) {
      return {
        command: configuredBinaryPath,
        args: []
      };
    }
    throw new Error(formatMissingBinaryMessage(configuredBinaryPath, candidates));
  }

  const binaryPath = candidates.find(candidate => existsSync(candidate));
  if (binaryPath) {
    return {
      command: binaryPath,
      args: []
    };
  }
```

The final throw at the end of `resolveAlvCliInvocation()` should become:

```ts
  throw new Error(formatMissingBinaryMessage(undefined, resolveBinaryCandidates(options)));
```

- [ ] **Step 5: Pass `options.env` into CLI invocation resolution**

In `runAlvCli()`, replace the `resolveAlvCliInvocation()` call with:

```ts
  const invocation = resolveAlvCliInvocation({
    repoRoot: options.repoRoot,
    allowWindowsCommandShim: options.allowWindowsCommandShim,
    env: options.env
  });
```

- [ ] **Step 6: Run the CLI helper tests and verify Task 3 now passes**

Run:

```bash
npx playwright test test/e2e/cli/specs/cliHelper.e2e.spec.ts --config=playwright.cli.config.ts
```

Expected: PASS for `cliHelper.e2e.spec.ts`.

- [ ] **Step 7: Commit Task 3 and Task 4**

Run:

```bash
git add test/e2e/cli/utils/cli.ts test/e2e/cli/specs/cliHelper.e2e.spec.ts
git commit -m "fix(e2e): pass resolved CLI binary to Playwright helpers"
```

## Task 5: Verify, push, and resume babysitting

**Files:**
- No code changes expected.
- Read: `docs/superpowers/specs/2026-05-06-cli-e2e-cargo-target-dir-design.md`

- [ ] **Step 1: Run focused Node script tests**

Run:

```bash
node --test scripts/run-playwright-cli-e2e.test.js
```

Expected: PASS.

- [ ] **Step 2: Run focused Playwright helper tests**

Run:

```bash
npx playwright test test/e2e/cli/specs/cliHelper.e2e.spec.ts --config=playwright.cli.config.ts
```

Expected: PASS.

- [ ] **Step 3: Run broader script regressions**

Run:

```bash
npm run test:scripts
```

Expected: PASS.

- [ ] **Step 4: Commit any verification-only doc updates**

Run only if `git status --short` shows intentional doc or test-result updates:

```bash
git add <intentional-files>
git commit -m "docs: update cli e2e target-dir notes"
```

Expected: Either no commit is needed, or the commit contains only intentional files.

- [ ] **Step 5: Push the PR branch**

Run:

```bash
git status --short
git push origin chore/cargo-target-dir-no-direnv
```

Expected: Push succeeds and updates PR #783.

- [ ] **Step 6: Resume PR watcher**

Run from the babysit-pr skill directory:

```bash
python3 scripts/gh_pr_watch.py --pr https://github.com/Electivus/Apex-Log-Viewer/pull/783 --watch
```

Expected: The watcher stays attached during passive states or exits with the next actionable/terminal snapshot.
