# Independent CLI Release and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the CLI into its own release train with `rust-v...` tags, publish it to `crates.io` and npm, and make the VS Code extension bundle a pinned tested CLI while still allowing a manual executable override.

**Architecture:** Keep the current extension release workflows intact for VSIX/Marketplace/Open VSX, add a dedicated Rust CLI release workflow, generate the npm meta/native packages from the CLI build outputs, and introduce explicit runtime bundle metadata so extension packaging downloads a tested CLI release instead of compiling workspace HEAD. Preserve the current app-server protocol shape by treating existing `runtime_version` as the CLI version field and adding only the missing release channel field.

**Tech Stack:** GitHub Actions, Cargo, Rust integration tests, Node.js build scripts, npm package generation, VS Code extension manifest settings, JSON metadata, app-server JSON-RPC over stdio.

---

## File Structure (what changes where)

**Create**
- `config/runtime-bundle.json`
- `packages/cli-npm/package.json`
- `packages/cli-npm/bin/apex-log-viewer.js`
- `packages/cli-npm/templates/package.meta.json`
- `packages/cli-npm/templates/package.native.json`
- `packages/cli-npm/README.md`
- `scripts/build-cli-npm-packages.mjs`
- `scripts/build-cli-npm-packages.test.js`
- `scripts/fetch-runtime-release.mjs`
- `scripts/fetch-runtime-release.test.js`
- `scripts/package-cli-release.mjs`
- `scripts/package-cli-release.test.js`
- `scripts/docs-release.test.js`
- `apps/vscode-extension/src/runtime/runtimeExecutable.ts`
- `apps/vscode-extension/src/test/runtime/runtimeExecutable.test.ts`
- `.github/workflows/rust-release.yml`

**Modify**
- `crates/alv-cli/Cargo.toml`
- `Cargo.toml`
- `crates/alv-protocol/src/messages.rs`
- `crates/alv-protocol/src/codegen.rs`
- `crates/alv-protocol/tests/protocol_schema.rs`
- `crates/alv-app-server/src/server.rs`
- `crates/alv-app-server/tests/app_server_smoke.rs`
- `crates/alv-cli/tests/cli_smoke.rs`
- `packages/app-server-client-ts/src/generated/index.ts`
- `apps/vscode-extension/src/runtime/runtimeClient.ts`
- `apps/vscode-extension/src/runtime/bundledBinary.ts`
- `apps/vscode-extension/package.json`
- `apps/vscode-extension/package.nls.json`
- `apps/vscode-extension/package.nls.pt-br.json`
- `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`
- `package.json`
- `scripts/build-runtime-target.mjs`
- `scripts/copy-runtime-binary.test.js`
- `scripts/packaging-ci.test.js`
- `.github/workflows/release.yml`
- `.github/workflows/prerelease.yml`
- `docs/CI.md`
- `docs/PUBLISHING.md`
- `docs/ARCHITECTURE.md`
- `CHANGELOG.md`

**Existing files that anchor the work**
- `crates/alv-cli/Cargo.toml`: current CLI package metadata and bin name.
- `crates/alv-app-server/src/server.rs`: current initialize handshake and stdio event loop.
- `packages/app-server-client-ts/src/generated/index.ts`: generated TypeScript surface for initialize.
- `apps/vscode-extension/src/runtime/runtimeClient.ts`: current daemon startup path and initialize call.
- `apps/vscode-extension/scripts/copy-runtime-binary.mjs`: current extension runtime bundling from local Cargo output.
- `.github/workflows/release.yml`: current extension tag-based release flow that still assumes the runtime is built from the workspace.

---

### Task 1: Extend the runtime handshake with explicit release channel metadata

**Files:**
- Modify: `crates/alv-protocol/src/messages.rs`
- Modify: `crates/alv-protocol/src/codegen.rs`
- Modify: `crates/alv-protocol/tests/protocol_schema.rs`
- Modify: `crates/alv-app-server/src/server.rs`
- Modify: `crates/alv-app-server/tests/app_server_smoke.rs`
- Modify: `crates/alv-cli/tests/cli_smoke.rs`
- Modify: `packages/app-server-client-ts/src/generated/index.ts`
- Modify: `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`

- [ ] **Step 1: Write the failing protocol and handshake assertions**

Add the missing `channel` field to the Rust and TypeScript-facing tests first.

Rust protocol contract update:

```rust
let result = InitializeResult {
    runtime_version: "0.1.0".to_string(),
    protocol_version: "1".to_string(),
    channel: "stable".to_string(),
    platform: "linux".to_string(),
    arch: "x86_64".to_string(),
    capabilities: RuntimeCapabilities {
        orgs: true,
        logs: true,
        search: true,
        tail: true,
        debug_flags: true,
        doctor: true,
    },
    state_dir: ".alv/state".to_string(),
    cache_dir: ".alv/cache".to_string(),
};

assert_eq!(
    serde_json::to_value(result).expect("result should serialize"),
    json!({
        "runtime_version": "0.1.0",
        "protocol_version": "1",
        "channel": "stable",
        "platform": "linux",
        "arch": "x86_64",
        "capabilities": {
            "orgs": true,
            "logs": true,
            "search": true,
            "tail": true,
            "debug_flags": true,
            "doctor": true
        },
        "state_dir": ".alv/state",
        "cache_dir": ".alv/cache"
    })
);
```

CLI smoke assertion update:

```rust
assert_eq!(initialize["result"]["protocol_version"], "1");
assert_eq!(initialize["result"]["channel"], "stable");
assert_eq!(initialize["result"]["capabilities"]["logs"], true);
```

TypeScript client test update:

```ts
return {
  runtime_version: '0.1.0',
  protocol_version: '1',
  channel: 'stable',
  platform: 'linux',
  arch: 'x64',
  capabilities: {
    orgs: true,
    logs: true,
    search: true,
    tail: true,
    debug_flags: true,
    doctor: true
  },
  state_dir: '.alv/state',
  cache_dir: '.alv/cache'
} as TResult;

assert.equal(result.channel, 'stable');
```

- [ ] **Step 2: Run the targeted tests to verify they fail for the right reason**

Run:

```bash
cargo test -p alv-protocol --test protocol_schema
cargo test -p alv-app-server --test app_server_smoke
cargo test -p alv-cli --test cli_smoke
npm run test:extension:node
node scripts/run-tests-cli.js --scope=unit
```

Expected: FAIL because `InitializeResult` and the generated TS type do not yet define `channel`.
`npm run test:extension:node` is still part of the red phase because it protects the node-only extension lane, but the edited handshake assertion in `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts` is reached through `node scripts/run-tests-cli.js --scope=unit`.

- [ ] **Step 3: Add the minimal handshake implementation and generated type surface**

Update the Rust protocol type:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitializeResult {
    pub runtime_version: String,
    pub protocol_version: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub capabilities: RuntimeCapabilities,
    pub state_dir: String,
    pub cache_dir: String,
}
```

Update `handle_initialize` to compute the channel from the package version string:

```rust
let runtime_version = env!("CARGO_PKG_VERSION").to_string();
let channel = if runtime_version.contains('-') {
    "pre-release".to_string()
} else {
    "stable".to_string()
};

InitializeResult {
    runtime_version,
    protocol_version: "1".to_string(),
    channel,
    platform: std::env::consts::OS.to_string(),
    arch: std::env::consts::ARCH.to_string(),
    capabilities: RuntimeCapabilities {
        orgs: true,
        logs: true,
        search: true,
        tail: true,
        debug_flags: true,
        doctor: true,
    },
    state_dir: ".alv/state".to_string(),
    cache_dir: ".alv/cache".to_string(),
}
```

Update the generated TypeScript surface:

```ts
export type InitializeResult = {
  runtime_version: string;
  protocol_version: string;
  channel: string;
  platform: string;
  arch: string;
  capabilities: RuntimeCapabilities;
  state_dir: string;
  cache_dir: string;
};
```

- [ ] **Step 4: Re-run the targeted tests and confirm they pass**

Run:

```bash
cargo test -p alv-protocol --test protocol_schema
cargo test -p alv-app-server --test app_server_smoke
cargo test -p alv-cli --test cli_smoke
npm run test:extension:node
node scripts/run-tests-cli.js --scope=unit
```

Expected: PASS for the targeted handshake work. The handshake now carries `channel`, the node-only extension lane still passes, and the extension-side runtime handshake assertion passes under the unit runner that actually executes `runtimeClient.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add crates/alv-protocol/src/messages.rs crates/alv-protocol/src/codegen.rs crates/alv-protocol/tests/protocol_schema.rs crates/alv-app-server/src/server.rs crates/alv-app-server/tests/app_server_smoke.rs crates/alv-cli/tests/cli_smoke.rs packages/app-server-client-ts/src/generated/index.ts apps/vscode-extension/src/test/runtime/runtimeClient.test.ts
git commit -m "feat(runtime): expose release channel in initialize handshake"
```

---

### Task 2: Add extension-side runtime resolution, pinned runtime metadata, and manual override UX

**Files:**
- Create: `config/runtime-bundle.json`
- Create: `apps/vscode-extension/src/runtime/runtimeExecutable.ts`
- Create: `apps/vscode-extension/src/test/runtime/runtimeExecutable.test.ts`
- Modify: `apps/vscode-extension/src/runtime/bundledBinary.ts`
- Modify: `apps/vscode-extension/src/runtime/runtimeClient.ts`
- Modify: `apps/vscode-extension/package.json`
- Modify: `apps/vscode-extension/package.nls.json`
- Modify: `apps/vscode-extension/package.nls.pt-br.json`
- Modify: `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`

- [ ] **Step 1: Write the failing extension tests for runtime resolution**

Create a resolver test that proves the extension prefers the configured CLI path and falls back to the bundled runtime otherwise:

```ts
import { strict as assert } from 'node:assert';
import { resolveRuntimeExecutable } from '../../runtime/runtimeExecutable';

suite('runtime executable', () => {
  test('uses configured runtimePath when present', () => {
    const result = resolveRuntimeExecutable({
      configuredPath: '/tmp/custom/apex-log-viewer',
      bundledPath: '/tmp/bundled/apex-log-viewer'
    });

    assert.equal(result.executable, '/tmp/custom/apex-log-viewer');
    assert.equal(result.source, 'configured');
    assert.equal(result.showManualOverrideWarning, true);
  });

  test('falls back to bundled runtime when runtimePath is empty', () => {
    const result = resolveRuntimeExecutable({
      configuredPath: '   ',
      bundledPath: '/tmp/bundled/apex-log-viewer'
    });

    assert.equal(result.executable, '/tmp/bundled/apex-log-viewer');
    assert.equal(result.source, 'bundled');
    assert.equal(result.showManualOverrideWarning, false);
  });
});
```

Add manifest assertions for the new setting:

```ts
assert.equal(
  packageJson.contributes.configuration.properties['electivus.apexLogs.runtimePath'].type,
  'string'
);
```

- [ ] **Step 2: Run the extension-side tests and confirm the new resolver is missing**

Run:

```bash
node scripts/run-tests-cli.js --scope=unit
```

Expected: FAIL because `runtimeExecutable.ts`, `runtimePath`, and the associated warning text do not exist yet. The new resolver and manifest assertions live under `apps/vscode-extension/src/test`, so they are exercised by the VS Code unit runner, not by `npm run test:extension:node`.

- [ ] **Step 3: Implement the runtime pin file, resolver, and manifest setting**

Add the pinned runtime metadata:

```json
{
  "cliVersion": "0.1.0",
  "tag": "rust-v0.1.0",
  "channel": "stable",
  "protocolVersion": "1"
}
```

Create the resolver:

```ts
export type RuntimeExecutableResolution = {
  executable: string;
  source: 'bundled' | 'configured';
  showManualOverrideWarning: boolean;
};

export function resolveRuntimeExecutable(args: {
  configuredPath: string;
  bundledPath: string;
}): RuntimeExecutableResolution {
  const configured = args.configuredPath.trim();
  if (configured) {
    return {
      executable: configured,
      source: 'configured',
      showManualOverrideWarning: true
    };
  }

  return {
    executable: args.bundledPath,
    source: 'bundled',
    showManualOverrideWarning: false
  };
}
```

Wire the client startup through the resolver instead of directly calling `resolveBundledBinary(...)`, and add the manifest/config strings:

```json
"electivus.apexLogs.runtimePath": {
  "type": "string",
  "default": "",
  "markdownDescription": "%configuration.electivus.apexLogs.runtimePath.description%"
}
```

English NLS text:

```json
"configuration.electivus.apexLogs.runtimePath.description": "DEVELOPMENT ONLY: Path to the Apex Log Viewer CLI executable. You do NOT need to set this unless you are actively developing the Apex Log Viewer CLI. If set manually, parts of the extension may not work as expected."
```

- [ ] **Step 4: Re-run the extension tests and verify the resolver path works**

Run:

```bash
node scripts/run-tests-cli.js --scope=unit
```

Expected: PASS. The extension manifest exposes `runtimePath`, and runtime startup can choose either the bundled or configured executable path.

- [ ] **Step 5: Commit**

```bash
git add config/runtime-bundle.json apps/vscode-extension/src/runtime/runtimeExecutable.ts apps/vscode-extension/src/test/runtime/runtimeExecutable.test.ts apps/vscode-extension/src/runtime/bundledBinary.ts apps/vscode-extension/src/runtime/runtimeClient.ts apps/vscode-extension/package.json apps/vscode-extension/package.nls.json apps/vscode-extension/package.nls.pt-br.json apps/vscode-extension/src/test/runtime/runtimeClient.test.ts
git commit -m "feat(extension): add pinned runtime metadata and manual CLI override"
```

---

### Task 3: Generate the npm meta package and native packages from CLI build outputs

**Files:**
- Create: `packages/cli-npm/package.json`
- Create: `packages/cli-npm/bin/apex-log-viewer.js`
- Create: `packages/cli-npm/templates/package.meta.json`
- Create: `packages/cli-npm/templates/package.native.json`
- Create: `packages/cli-npm/README.md`
- Create: `scripts/build-cli-npm-packages.mjs`
- Create: `scripts/build-cli-npm-packages.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing package-generation tests**

Add a script test that proves the staging output has the right names, versions, and optional dependencies:

```js
test('buildCliNpmPackages generates the meta package with all native optionalDependencies', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-npm-'));

  const result = mod.buildCliNpmPackages({
    version: '1.2.3',
    outDir,
    binaries: {
      'linux-x64': '/artifacts/linux-x64/apex-log-viewer',
      'darwin-arm64': '/artifacts/darwin-arm64/apex-log-viewer'
    }
  });

  const metaPackage = JSON.parse(
    fs.readFileSync(path.join(result.metaDir, 'package.json'), 'utf8')
  );

  assert.equal(metaPackage.name, '@electivus/apex-log-viewer');
  assert.equal(metaPackage.version, '1.2.3');
  assert.equal(
    metaPackage.optionalDependencies['@electivus/apex-log-viewer-linux-x64'],
    '1.2.3'
  );
});
```

Add a launcher mapping test:

```js
assert.equal(resolvePackageForTarget('linux', 'x64'), '@electivus/apex-log-viewer-linux-x64');
assert.equal(resolvePackageForTarget('darwin', 'arm64'), '@electivus/apex-log-viewer-darwin-arm64');
```

- [ ] **Step 2: Run the script test and confirm the npm packaging layer is missing**

Run:

```bash
node --test scripts/build-cli-npm-packages.test.js
```

Expected: FAIL because `build-cli-npm-packages.mjs` and the npm packaging templates do not exist yet.

- [ ] **Step 3: Implement the package generator and launcher**

Create the launcher package map:

```js
export const PACKAGE_BY_TARGET = {
  'linux-x64': '@electivus/apex-log-viewer-linux-x64',
  'linux-arm64': '@electivus/apex-log-viewer-linux-arm64',
  'darwin-x64': '@electivus/apex-log-viewer-darwin-x64',
  'darwin-arm64': '@electivus/apex-log-viewer-darwin-arm64',
  'win32-x64': '@electivus/apex-log-viewer-win32-x64',
  'win32-arm64': '@electivus/apex-log-viewer-win32-arm64'
};
```

Meta package template:

```json
{
  "name": "@electivus/apex-log-viewer",
  "version": "__VERSION__",
  "bin": {
    "apex-log-viewer": "bin/apex-log-viewer.js"
  },
  "optionalDependencies": {
    "@electivus/apex-log-viewer-linux-x64": "__VERSION__",
    "@electivus/apex-log-viewer-linux-arm64": "__VERSION__",
    "@electivus/apex-log-viewer-darwin-x64": "__VERSION__",
    "@electivus/apex-log-viewer-darwin-arm64": "__VERSION__",
    "@electivus/apex-log-viewer-win32-x64": "__VERSION__",
    "@electivus/apex-log-viewer-win32-arm64": "__VERSION__"
  }
}
```

Native package template:

```json
{
  "name": "__PACKAGE_NAME__",
  "version": "__VERSION__",
  "os": ["__OS__"],
  "cpu": ["__CPU__"],
  "bin": {
    "apex-log-viewer": "bin/__BINARY_NAME__"
  }
}
```

Root script entry:

```json
"build:cli:npm": "node scripts/build-cli-npm-packages.mjs"
```

- [ ] **Step 4: Re-run the script test and confirm the generated package layout is correct**

Run:

```bash
node --test scripts/build-cli-npm-packages.test.js
```

Expected: PASS. The staging directory contains a meta package and one native package directory per target with synchronized versions.

- [ ] **Step 5: Commit**

```bash
git add packages/cli-npm/package.json packages/cli-npm/bin/apex-log-viewer.js packages/cli-npm/templates/package.meta.json packages/cli-npm/templates/package.native.json packages/cli-npm/README.md scripts/build-cli-npm-packages.mjs scripts/build-cli-npm-packages.test.js package.json
git commit -m "feat(cli): generate npm meta and native packages"
```

---

### Task 4: Fetch pinned CLI release assets for extension packaging instead of building workspace HEAD

**Files:**
- Create: `scripts/fetch-runtime-release.mjs`
- Create: `scripts/fetch-runtime-release.test.js`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/prerelease.yml`
- Modify: `scripts/packaging-ci.test.js`

- [ ] **Step 1: Write the failing tests for pinned runtime asset resolution**

Create a script test that proves the fetcher reads `config/runtime-bundle.json` and resolves the GitHub asset name deterministically:

```js
test('resolveRuntimeAssetName uses the pinned CLI version and target', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  assert.equal(
    mod.resolveRuntimeAssetName({ cliVersion: '1.2.3', target: 'linux-x64' }),
    'apex-log-viewer-1.2.3-linux-x64.tar.gz'
  );
  assert.equal(
    mod.resolveRuntimeAssetName({ cliVersion: '1.2.3', target: 'win32-x64' }),
    'apex-log-viewer-1.2.3-win32-x64.zip'
  );
});
```

Add a workflow-oriented regression assertion:

```js
assert.match(releaseWorkflow, /node scripts\/fetch-runtime-release\.mjs "\$\{MATRIX_TARGET\}"/);
assert.doesNotMatch(releaseWorkflow, /node scripts\/build-runtime-target\.mjs "\$\{MATRIX_TARGET\}" release/);
```

- [ ] **Step 2: Run the script tests and confirm the pinned fetch path is not implemented yet**

Run:

```bash
node --test scripts/fetch-runtime-release.test.js scripts/packaging-ci.test.js
```

Expected: FAIL because there is no pinned runtime fetcher and the extension release workflows still build the runtime from the workspace.

- [ ] **Step 3: Implement the pinned runtime fetcher and switch packaging flows**

Create a fetcher that reads the bundle metadata and installs the release asset into `apps/vscode-extension/bin/<target>/`:

```js
export function resolveRuntimeAssetName({ cliVersion, target }) {
  if (target.startsWith('win32-')) {
    return `apex-log-viewer-${cliVersion}-${target}.zip`;
  }
  return `apex-log-viewer-${cliVersion}-${target}.tar.gz`;
}

export function resolveRuntimeReleaseTag({ tag, cliVersion }) {
  return tag || `rust-v${cliVersion}`;
}
```

Update root scripts so the workflows use pinned assets for packaging:

```json
"package:runtime": "node scripts/fetch-runtime-release.mjs",
"package:runtime:local": "cargo build -p electivus-apex-log-viewer-cli --bin apex-log-viewer --release && node apps/vscode-extension/scripts/copy-runtime-binary.mjs release"
```

Update the extension release jobs to fetch the pinned CLI release asset per target instead of calling `build-runtime-target.mjs`.

- [ ] **Step 4: Re-run the script tests and confirm the release workflows now point at pinned assets**

Run:

```bash
node --test scripts/fetch-runtime-release.test.js scripts/packaging-ci.test.js
```

Expected: PASS. The extension packaging flow now resolves the runtime from `config/runtime-bundle.json` for release builds.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-runtime-release.mjs scripts/fetch-runtime-release.test.js package.json .github/workflows/release.yml .github/workflows/prerelease.yml scripts/packaging-ci.test.js
git commit -m "build(extension): fetch pinned CLI release assets for packaging"
```

---

### Task 5: Rename the public Cargo package, package release artifacts, and add the dedicated CLI release workflow

**Files:**
- Modify: `crates/alv-cli/Cargo.toml`
- Modify: `Cargo.toml`
- Modify: `package.json`
- Modify: `scripts/build-runtime-target.mjs`
- Modify: `scripts/copy-runtime-binary.test.js`
- Create: `scripts/package-cli-release.mjs`
- Create: `scripts/package-cli-release.test.js`
- Create: `.github/workflows/rust-release.yml`

- [ ] **Step 1: Write the failing tests for the renamed package and release asset staging**

Update the existing Cargo build-arg test to reflect the public package name:

```js
assert.deepEqual(
  mod.resolveCargoBuildArgs('linux-arm64', 'release'),
  [
    'build',
    '-p',
    'electivus-apex-log-viewer-cli',
    '--bin',
    'apex-log-viewer',
    '--release',
    '--target',
    'aarch64-unknown-linux-gnu'
  ]
);
```

Add a release packaging test:

```js
test('packageCliRelease writes platform archives and a checksum file', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-cli-release-'));

  const result = mod.packageCliRelease({
    version: '1.2.3',
    outDir,
    binaries: {
      'linux-x64': '/repo/target/x86_64-unknown-linux-gnu/release/apex-log-viewer',
      'win32-x64': '/repo/target/x86_64-pc-windows-msvc/release/apex-log-viewer.exe'
    }
  });

  assert.match(result.assets[0], /apex-log-viewer-1\.2\.3-linux-x64\.tar\.gz$/);
  assert.match(result.checksumsFile, /SHA256SUMS\.txt$/);
});
```

- [ ] **Step 2: Run the script tests and confirm the public package/release workflow path is still missing**

Run:

```bash
node --test scripts/copy-runtime-binary.test.js scripts/package-cli-release.test.js
```

Expected: FAIL because the workspace still builds `-p alv-cli`, there is no release packaging script, and there is no dedicated `.github/workflows/rust-release.yml`.

- [ ] **Step 3: Implement the public package rename, release packager, and workflow**

Rename the Cargo package:

```toml
[package]
name = "electivus-apex-log-viewer-cli"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "apex-log-viewer"
path = "src/main.rs"
```

Add a release packager contract:

```js
export function resolveReleaseAssetName(version, target) {
  return target.startsWith('win32-')
    ? `apex-log-viewer-${version}-${target}.zip`
    : `apex-log-viewer-${version}-${target}.tar.gz`;
}
```

Add the new workflow with the real job order and validation command:

```yaml
name: Rust CLI Release

on:
  push:
    tags:
      - 'rust-v*'

jobs:
  validate_tag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Verify tag matches CLI package version
        shell: bash
        run: |
          set -euo pipefail
          PKG_VERSION=$(node -e "const fs=require('fs');const toml=fs.readFileSync('crates/alv-cli/Cargo.toml','utf8');const match=toml.match(/^version = \"([^\"]+)\"/m);if(!match){process.exit(1)}process.stdout.write(match[1])")
          TAG_VERSION="${GITHUB_REF_NAME#rust-v}"
          if [ "$PKG_VERSION" != "$TAG_VERSION" ]; then
            echo "Tag $GITHUB_REF_NAME != crates/alv-cli/Cargo.toml version $PKG_VERSION" >&2
            exit 1
          fi

  test_rust:
    needs: validate_tag
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci --workspaces=false
      - run: npm run test:rust

  build_matrix:
    needs: test_rust
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            target: linux-x64
            cargo_target: x86_64-unknown-linux-gnu
          - os: ubuntu-latest
            target: linux-arm64
            cargo_target: aarch64-unknown-linux-gnu
          - os: macos-latest
            target: darwin-x64
            cargo_target: x86_64-apple-darwin
          - os: macos-latest
            target: darwin-arm64
            cargo_target: aarch64-apple-darwin
          - os: windows-latest
            target: win32-x64
            cargo_target: x86_64-pc-windows-msvc
          - os: windows-latest
            target: win32-arm64
            cargo_target: aarch64-pc-windows-msvc
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci --workspaces=false
      - run: rustup target add ${{ matrix.cargo_target }}
      - run: node scripts/build-runtime-target.mjs "${{ matrix.target }}" release
      - run: node scripts/package-cli-release.mjs "${{ matrix.target }}"
      - run: node scripts/build-cli-npm-packages.mjs "${{ matrix.target }}"

  publish_npm_native:
    needs: build_matrix
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
      - shell: bash
        run: |
          set -euo pipefail
          for dir in dist/npm/native/*; do
            npm publish "$dir" --tag "${NPM_DIST_TAG}" --access public
          done

  publish_npm_meta:
    needs: publish_npm_native
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
      - run: npm publish dist/npm/meta --tag "${NPM_DIST_TAG}" --access public

  publish_crate:
    needs: build_matrix
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: cargo publish --manifest-path crates/alv-cli/Cargo.toml

  release:
    needs: [publish_npm_meta, publish_crate]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
      - run: gh release upload "${GITHUB_REF_NAME}" dist/release/* --clobber
```

- [ ] **Step 4: Re-run the script tests and validate the workflow path**

Run:

```bash
node --test scripts/copy-runtime-binary.test.js scripts/package-cli-release.test.js
```

Expected: PASS. The repo scripts now build the renamed package id and can stage release archives predictably.

- [ ] **Step 5: Commit**

```bash
git add crates/alv-cli/Cargo.toml Cargo.toml package.json scripts/build-runtime-target.mjs scripts/copy-runtime-binary.test.js scripts/package-cli-release.mjs scripts/package-cli-release.test.js .github/workflows/rust-release.yml
git commit -m "ci(cli): add dedicated Rust release workflow"
```

---

### Task 6: Document the two release trains and the new maintainer workflow

**Files:**
- Modify: `docs/CI.md`
- Modify: `docs/PUBLISHING.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Create: `scripts/docs-release.test.js`

- [ ] **Step 1: Write the failing documentation assertions**

Create a doc smoke test so the release docs have an explicit red/green loop:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('release docs mention the dedicated CLI workflow and pinned runtime metadata', () => {
  const ci = fs.readFileSync('docs/CI.md', 'utf8');
  const publishing = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
  const architecture = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');

  assert.match(ci, /rust-release\.yml/);
  assert.match(ci, /CARGO_REGISTRY_TOKEN/);
  assert.match(publishing, /rust-vX\.Y\.Z/);
  assert.match(architecture, /config\/runtime-bundle\.json/);
  assert.match(changelog, /independent Rust CLI release train/i);
});
```

- [ ] **Step 2: Run the minimal verification for the docs lane**

Run:

```bash
node --test scripts/docs-release.test.js
```

Expected before changes: FAIL because the docs do not yet mention the dedicated CLI release workflow, `CARGO_REGISTRY_TOKEN`, or `config/runtime-bundle.json`.

- [ ] **Step 3: Update the maintainer docs and changelog**

Update `docs/CI.md` to describe the new CLI release workflow and secrets:

```md
- Workflow Rust CLI Release (`.github/workflows/rust-release.yml`): runs on `rust-v*` tags, publishes GitHub release assets, native npm packages, the npm meta package, and the CLI crate to `crates.io`.
- Required repository secrets for CLI publish:
  - `NPM_TOKEN`
  - `CARGO_REGISTRY_TOKEN`
```

Update `docs/PUBLISHING.md` with separate quick-start sections:

```md
### CLI releases

1. Bump `crates/alv-cli/Cargo.toml`.
2. Push tag `rust-vX.Y.Z` or `rust-vX.Y.Z-alpha.N`.
3. The Rust CLI release workflow publishes GitHub assets, npm packages, and the crate.
```

Update `docs/ARCHITECTURE.md` to explain that extension packaging consumes `config/runtime-bundle.json` for release bundling.

Add a short `CHANGELOG.md` maintainer note:

```md
- Maintainers: add an independent Rust CLI release train with `rust-v...` tags, npm native packages, and `crates.io` publishing.
```

- [ ] **Step 4: Re-run the docs verification**

Run:

```bash
node --test scripts/docs-release.test.js
```

Expected: PASS with matches in all four files describing the CLI release train and extension pinning model.

- [ ] **Step 5: Commit**

```bash
git add docs/CI.md docs/PUBLISHING.md docs/ARCHITECTURE.md CHANGELOG.md scripts/docs-release.test.js
git commit -m "docs(release): document independent CLI publishing flow"
```

---

## Self-Review

### Spec coverage

- Independent CLI tags `rust-v...`: covered by Task 5.
- Stable and pre-release separation for CLI: covered by Tasks 1 and 5.
- npm meta package plus native packages: covered by Task 3.
- `crates.io` publishing: covered by Task 5.
- Extension pinned to a validated CLI release: covered by Tasks 2 and 4.
- Manual `runtimePath` override with warning-only behavior: covered by Task 2.
- GitHub Release assets and checksums: covered by Task 5.
- Docs and maintainer guidance: covered by Task 6.

### Placeholder scan

- No `TBD`, `TODO`, or "implement later" placeholders remain.
- The protocol naming choice is explicit: keep existing `runtime_version` and add `channel`.
- The public crate/package names are explicit.
- The extension bundle metadata file is explicit: `config/runtime-bundle.json`.

### Type consistency

- Wire contract remains `runtime_version` / `protocol_version` plus new `channel`.
- Extension setting name is consistently `electivus.apexLogs.runtimePath`.
- The public npm package name is consistently `@electivus/apex-log-viewer`.
- The public Cargo package name is consistently `electivus-apex-log-viewer-cli`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-03-29-independent-cli-release.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
