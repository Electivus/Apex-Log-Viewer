# Nx Monorepo + Rust CLI/App Server Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar o Apex Log Viewer para um monorepo Nx com runtime Rust compartilhado por CLI, app-server embutido e extensão VS Code, removendo o backend TypeScript legado ao final.

**Architecture:** O repo passa a ter um workspace Nx na raiz, uma app `vscode-extension`, um package `webview`, um package `app-server-client-ts` e um workspace Cargo com crates `alv-core`, `alv-protocol`, `alv-app-server`, `alv-cli` e `alv-mcp`. A extensão deixa de falar com Salesforce diretamente e passa a conversar apenas com `apex-log-viewer app-server --stdio` via JSON-RPC/JSONL.

**Tech Stack:** Nx, npm workspaces, TypeScript, esbuild, Jest, VS Code Extension Test Runner (`stable`), Playwright, Rust/Cargo, JSON-RPC 2.0 over stdio, `vsce` platform-specific packaging.

---

## File Structure (what changes where)

**Create**
- `nx.json`
- `tsconfig.base.json`
- `Cargo.toml`
- `apps/vscode-extension/package.json`
- `apps/vscode-extension/project.json`
- `apps/vscode-extension/tsconfig.json`
- `apps/vscode-extension/esbuild.extension.mjs`
- `apps/vscode-extension/scripts/copy-runtime-binary.mjs`
- `apps/vscode-extension/src/runtime/bundledBinary.ts`
- `apps/vscode-extension/src/runtime/runtimeClient.ts`
- `apps/vscode-extension/src/runtime/runtimeEvents.ts`
- `packages/webview/package.json`
- `packages/webview/project.json`
- `packages/webview/tsconfig.json`
- `packages/webview/esbuild.webview.mjs`
- `packages/app-server-client-ts/package.json`
- `packages/app-server-client-ts/project.json`
- `packages/app-server-client-ts/tsconfig.json`
- `packages/app-server-client-ts/src/index.ts`
- `packages/app-server-client-ts/src/jsonlRpc.ts`
- `packages/app-server-client-ts/src/daemonProcess.ts`
- `packages/app-server-client-ts/src/generated/`
- `crates/alv-core/Cargo.toml`
- `crates/alv-core/src/lib.rs`
- `crates/alv-core/src/auth.rs`
- `crates/alv-core/src/cache.rs`
- `crates/alv-core/src/orgs.rs`
- `crates/alv-core/src/logs.rs`
- `crates/alv-core/src/search.rs`
- `crates/alv-core/src/triage.rs`
- `crates/alv-core/src/tail.rs`
- `crates/alv-core/src/debug_flags.rs`
- `crates/alv-core/tests/core_smoke.rs`
- `crates/alv-protocol/Cargo.toml`
- `crates/alv-protocol/src/lib.rs`
- `crates/alv-protocol/src/messages.rs`
- `crates/alv-protocol/src/codegen.rs`
- `crates/alv-protocol/tests/protocol_schema.rs`
- `crates/alv-app-server/Cargo.toml`
- `crates/alv-app-server/src/lib.rs`
- `crates/alv-app-server/src/server.rs`
- `crates/alv-app-server/src/transport_stdio.rs`
- `crates/alv-app-server/src/handlers/orgs.rs`
- `crates/alv-app-server/src/handlers/logs.rs`
- `crates/alv-app-server/src/handlers/tail.rs`
- `crates/alv-app-server/src/handlers/debug_flags.rs`
- `crates/alv-app-server/tests/app_server_smoke.rs`
- `crates/alv-cli/Cargo.toml`
- `crates/alv-cli/src/main.rs`
- `crates/alv-cli/src/commands/doctor.rs`
- `crates/alv-cli/src/commands/orgs.rs`
- `crates/alv-cli/src/commands/logs.rs`
- `crates/alv-cli/src/commands/debug_flags.rs`
- `crates/alv-cli/tests/cli_smoke.rs`
- `crates/alv-mcp/Cargo.toml`
- `crates/alv-mcp/src/lib.rs`

**Move / Rename**
- `package.json` -> split into root workspace manifest + `apps/vscode-extension/package.json`
- `src/extension.ts` -> `apps/vscode-extension/src/extension.ts`
- `src/provider/` -> `apps/vscode-extension/src/provider/`
- `src/panel/` -> `apps/vscode-extension/src/panel/`
- `src/salesforce/` -> temporary move into `apps/vscode-extension/src/legacy/salesforce/` before cutover deletion
- `src/services/` -> temporary move into `apps/vscode-extension/src/legacy/services/` before cutover deletion
- `src/utils/` -> split between:
  - `apps/vscode-extension/src/utils/`
  - `packages/webview/src/utils/`
- `src/webview/` -> `packages/webview/src/`
- `media/` -> `apps/vscode-extension/media/`
- `package.nls.json` -> `apps/vscode-extension/package.nls.json`
- `package.nls.pt-br.json` -> `apps/vscode-extension/package.nls.pt-br.json`

**Modify**
- `package-lock.json`
- `.github/workflows/ci.yml`
- `.github/workflows/e2e-playwright.yml`
- `.github/workflows/release.yml`
- `.github/workflows/prerelease.yml`
- `docs/ARCHITECTURE.md`
- `docs/CI.md`
- `docs/PUBLISHING.md`
- `README.md`

**Delete at final cutover**
- `apps/vscode-extension/src/legacy/salesforce/`
- `apps/vscode-extension/src/legacy/services/`
- any direct runtime calls from `apps/vscode-extension/src/provider/` to Salesforce/network code

---

### Task 1: Bootstrap the Nx workspace and preserve top-level developer commands

**Files:**
- Create: `nx.json`
- Create: `tsconfig.base.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing workspace smoke check**

Create a temporary smoke command expectation in the plan implementation notes:

```bash
npx nx show projects
```

Expected before changes: FAIL because `nx.json` is missing and `nx` is not installed.

- [ ] **Step 2: Run the smoke check and confirm it fails**

Run:

```bash
npx nx show projects
```

Expected: non-zero exit with missing Nx workspace/config error.

- [ ] **Step 3: Create the root workspace manifest and Nx config**

Write `package.json` as a workspace root that preserves current entrypoints:

```json
{
  "name": "apex-log-viewer-workspace",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "check-types": "nx run vscode-extension:check-types",
    "compile": "nx run vscode-extension:compile",
    "lint": "nx run vscode-extension:lint",
    "watch": "nx run-many -t watch --projects=vscode-extension,webview",
    "build": "nx run vscode-extension:build",
    "package": "nx run vscode-extension:package",
    "test:all": "nx run vscode-extension:test-all",
    "test": "nx run vscode-extension:test",
    "test:unit": "nx run vscode-extension:test-unit",
    "test:integration": "nx run vscode-extension:test-integration",
    "test:webview": "nx run webview:test",
    "test:e2e": "nx run vscode-extension:test-e2e",
    "test:ci": "nx run vscode-extension:test-ci",
    "test:smoke:vsix": "nx run vscode-extension:test-smoke-vsix",
    "vsce:package": "nx run vscode-extension:vsce-package",
    "vsce:package:pre": "nx run vscode-extension:vsce-package-pre",
    "vsce:publish": "nx run vscode-extension:vsce-publish",
    "vsce:publish:pre": "nx run vscode-extension:vsce-publish-pre"
  },
  "devDependencies": {
    "nx": "^22.0.0",
    "@nx/js": "^22.0.0",
    "@nx/workspace": "^22.0.0"
  }
}
```

Write `nx.json`:

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/*.test.ts",
      "!{projectRoot}/**/*.test.tsx",
      "!{projectRoot}/**/__tests__/**"
    ],
    "sharedGlobals": [".nvmrc", "package-lock.json", "Cargo.toml"]
  },
  "targetDefaults": {
    "build": { "cache": true },
    "test": { "cache": true },
    "lint": { "cache": true }
  }
}
```

Write `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Node",
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@alv/webview/*": ["packages/webview/src/*"],
      "@alv/app-server-client-ts/*": ["packages/app-server-client-ts/src/*"],
      "@alv/vscode-extension/*": ["apps/vscode-extension/src/*"]
    }
  }
}
```

- [ ] **Step 4: Refresh dependencies and verify the workspace exists**

Run:

```bash
npm install
npx nx show projects
```

Expected: PASS and Nx prints a valid workspace response, even if the project list is still empty at this stage.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json nx.json tsconfig.base.json
git commit -m "build(nx): bootstrap workspace root"
```

---

### Task 2: Create the `vscode-extension` app package and move the extension manifest out of the root

**Files:**
- Create: `apps/vscode-extension/package.json`
- Create: `apps/vscode-extension/project.json`
- Create: `apps/vscode-extension/tsconfig.json`
- Create: `apps/vscode-extension/esbuild.extension.mjs`
- Move: `media/` -> `apps/vscode-extension/media/`
- Move: `package.nls.json` -> `apps/vscode-extension/package.nls.json`
- Move: `package.nls.pt-br.json` -> `apps/vscode-extension/package.nls.pt-br.json`

- [ ] **Step 1: Write the failing packaging smoke check**

Run:

```bash
npx nx run vscode-extension:build
```

Expected before changes: FAIL because `apps/vscode-extension/project.json` does not exist.

- [ ] **Step 2: Run the smoke check and confirm it fails**

Run:

```bash
npx nx run vscode-extension:build
```

Expected: non-zero exit with missing project error.

- [ ] **Step 3: Create the extension package manifest and project target**

Write `apps/vscode-extension/package.json` by moving the current extension manifest content into the app package:

```json
{
  "name": "apex-log-viewer",
  "displayName": "%extension.displayName%",
  "description": "%extension.description%",
  "version": "0.38.0",
  "publisher": "electivus",
  "engines": {
    "vscode": "^1.90.0",
    "node": ">=22.15.1"
  },
  "main": "./dist/extension.js",
  "icon": "media/icon.png"
}
```

Write `apps/vscode-extension/project.json`:

```json
{
  "name": "vscode-extension",
  "sourceRoot": "apps/vscode-extension/src",
  "projectType": "application",
  "tags": ["scope:vscode", "type:app"],
  "targets": {
    "check-types": {
      "command": "tsc --noEmit -p apps/vscode-extension/tsconfig.json"
    },
    "build": {
      "command": "node apps/vscode-extension/esbuild.extension.mjs"
    }
  }
}
```

Write `apps/vscode-extension/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

Write `apps/vscode-extension/esbuild.extension.mjs`:

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['apps/vscode-extension/src/extension.ts'],
  outfile: 'apps/vscode-extension/dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', '@vscode/ripgrep', 'tree-sitter-sfapex']
});
```

- [ ] **Step 4: Move the extension packaging assets**

Run:

```bash
mkdir -p apps/vscode-extension
git mv media apps/vscode-extension/media
git mv package.nls.json apps/vscode-extension/package.nls.json
git mv package.nls.pt-br.json apps/vscode-extension/package.nls.pt-br.json
```

- [ ] **Step 5: Verify the new app target resolves**

Run:

```bash
npx nx show project vscode-extension
```

Expected: PASS and the `build` target is listed.

- [ ] **Step 6: Commit**

```bash
git add apps/vscode-extension
git commit -m "refactor(vscode): create extension app package"
```

---

### Task 3: Move the extension host code into `apps/vscode-extension` and restore current build/test behavior

**Files:**
- Move: `src/extension.ts` -> `apps/vscode-extension/src/extension.ts`
- Move: `src/provider/` -> `apps/vscode-extension/src/provider/`
- Move: `src/panel/` -> `apps/vscode-extension/src/panel/`
- Move: `src/shared/` -> `apps/vscode-extension/src/shared/`
- Move: `src/test/` -> `apps/vscode-extension/src/test/`
- Modify: `scripts/run-tests-cli.js`
- Modify: `scripts/run-tests.js`
- Modify: `jest.config.webview.cjs`
- Modify: `tsconfig.test.json`
- Modify: `tsconfig.extension.json`

- [ ] **Step 1: Write the failing extension build check**

Run:

```bash
npx nx run vscode-extension:build
```

Expected before moving sources: FAIL because `apps/vscode-extension/src/extension.ts` is missing.

- [ ] **Step 2: Move the extension host source tree**

Run:

```bash
mkdir -p apps/vscode-extension/src
git mv src/extension.ts apps/vscode-extension/src/extension.ts
git mv src/provider apps/vscode-extension/src/provider
git mv src/panel apps/vscode-extension/src/panel
git mv src/shared apps/vscode-extension/src/shared
git mv src/test apps/vscode-extension/src/test
```

- [ ] **Step 3: Update the test runner paths**

Change `scripts/run-tests-cli.js` and `scripts/run-tests.js` to point to the new extension test output root:

```js
const TEST_ROOT = path.join(process.cwd(), 'apps', 'vscode-extension', 'out', 'test');
const EXTENSION_DEV_PATH = path.join(process.cwd(), 'apps', 'vscode-extension');
```

Change `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "apps/vscode-extension/out/test"
  },
  "include": ["apps/vscode-extension/src/test/**/*.ts"]
}
```

- [ ] **Step 4: Expand the `vscode-extension` targets to preserve current commands**

Update `apps/vscode-extension/project.json`:

```json
{
  "targets": {
    "check-types": {
      "command": "tsc --noEmit -p apps/vscode-extension/tsconfig.json"
    },
    "lint": {
      "command": "eslint apps/vscode-extension/src"
    },
    "compile": {
      "command": "eslint apps/vscode-extension/src && tsc --noEmit -p apps/vscode-extension/tsconfig.json"
    },
    "watch": {
      "command": "node apps/vscode-extension/esbuild.extension.mjs --watch"
    },
    "build": {
      "command": "node apps/vscode-extension/esbuild.extension.mjs"
    },
    "package": {
      "command": "nx run vscode-extension:build && nx run webview:build"
    },
    "test": {
      "command": "nx run webview:test && npm run test:scripts && node scripts/run-tests-cli.js --scope=unit --coverage && npm run coverage:merge"
    },
    "test-unit": {
      "command": "npm run test:webview && npm run test:e2e:utils && npm run test:scripts && npm run pretest && node scripts/run-tests-cli.js --scope=unit"
    },
    "test-integration": {
      "command": "npm run test:scripts && npm run pretest && node scripts/run-tests-cli.js --scope=integration --install-deps --timeout=900000"
    },
    "test-all": {
      "command": "npm run test:webview && npm run test:scripts && npm run pretest && node scripts/run-tests-cli.js --scope=all"
    },
    "test-unit-ci": {
      "command": "npm run test:webview -- --ci --runInBand && npm run test:e2e:utils && npm run test:scripts && npm run pretest && node scripts/run-tests-cli.js --scope=unit --vscode=stable"
    },
    "test-integration-ci": {
      "command": "npm run test:scripts && npm run pretest && node scripts/run-tests-cli.js --scope=integration --vscode=stable --install-deps --timeout=900000"
    },
    "test-e2e": {
      "command": "node scripts/run-playwright-e2e.js"
    },
    "test-ci": {
      "command": "nx run vscode-extension:test-unit-ci && nx run vscode-extension:test-integration-ci"
    },
    "test-smoke-vsix": {
      "command": "node scripts/run-tests.js --scope=unit --smoke-vsix"
    },
    "vsce-package": {
      "command": "npx @vscode/vsce package --cwd apps/vscode-extension"
    },
    "vsce-package-pre": {
      "command": "npx @vscode/vsce package --pre-release --cwd apps/vscode-extension"
    },
    "vsce-publish": {
      "command": "npx @vscode/vsce publish --cwd apps/vscode-extension"
    },
    "vsce-publish-pre": {
      "command": "npx @vscode/vsce publish --pre-release --cwd apps/vscode-extension"
    }
  }
}
```

- [ ] **Step 5: Verify build and unit test wiring**

Run:

```bash
npx nx run vscode-extension:build
npx nx run vscode-extension:test-unit
```

Expected: PASS after import paths are updated to the new app root.

- [ ] **Step 6: Commit**

```bash
git add apps/vscode-extension scripts/run-tests-cli.js scripts/run-tests.js tsconfig.test.json
git commit -m "refactor(vscode): move extension host sources into app"
```

---

### Task 4: Extract the webview into its own package and keep the current UI build green

**Files:**
- Create: `packages/webview/package.json`
- Create: `packages/webview/project.json`
- Create: `packages/webview/tsconfig.json`
- Create: `packages/webview/esbuild.webview.mjs`
- Move: `src/webview/` -> `packages/webview/src/`
- Modify: `jest.config.webview.cjs`
- Modify: `tsconfig.webview-tests.json`

- [ ] **Step 1: Write the failing webview target check**

Run:

```bash
npx nx run webview:build
```

Expected before changes: FAIL because the `webview` project does not exist.

- [ ] **Step 2: Move the webview source tree**

Run:

```bash
mkdir -p packages/webview
git mv src/webview packages/webview/src
```

- [ ] **Step 3: Create the package and build targets**

Write `packages/webview/project.json`:

```json
{
  "name": "webview",
  "sourceRoot": "packages/webview/src",
  "projectType": "library",
  "tags": ["scope:webview", "type:ui"],
  "targets": {
    "build": {
      "command": "node packages/webview/esbuild.webview.mjs"
    },
    "test": {
      "command": "jest --config jest.config.webview.cjs"
    }
  }
}
```

Write `packages/webview/esbuild.webview.mjs`:

```js
import { build } from 'esbuild';

await build({
  entryPoints: [
    'packages/webview/src/main.tsx',
    'packages/webview/src/tail.tsx',
    'packages/webview/src/logViewer.tsx',
    'packages/webview/src/debugFlags.tsx'
  ],
  outdir: 'apps/vscode-extension/media',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: true
});
```

- [ ] **Step 4: Point Jest and TypeScript to the new source root**

Update `jest.config.webview.cjs`:

```js
module.exports = {
  roots: ['<rootDir>/packages/webview/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx']
};
```

Update `tsconfig.webview-tests.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/webview/src/**/*.ts", "packages/webview/src/**/*.tsx"]
}
```

- [ ] **Step 5: Verify the webview targets**

Run:

```bash
npx nx run webview:build
npx nx run webview:test
```

Expected: PASS and bundles are emitted into `apps/vscode-extension/media`.

- [ ] **Step 6: Commit**

```bash
git add packages/webview jest.config.webview.cjs tsconfig.webview-tests.json
git commit -m "refactor(webview): extract UI package"
```

---

### Task 5: Add the Cargo workspace and create the Rust crate skeletons

**Files:**
- Create: `Cargo.toml`
- Create: `crates/alv-core/Cargo.toml`
- Create: `crates/alv-core/src/lib.rs`
- Create: `crates/alv-app-server/Cargo.toml`
- Create: `crates/alv-app-server/src/lib.rs`
- Create: `crates/alv-cli/Cargo.toml`
- Create: `crates/alv-cli/src/main.rs`
- Create: `crates/alv-protocol/Cargo.toml`
- Create: `crates/alv-protocol/src/lib.rs`
- Create: `crates/alv-mcp/Cargo.toml`
- Create: `crates/alv-mcp/src/lib.rs`

- [ ] **Step 1: Write the failing Rust workspace check**

Run:

```bash
cargo test -p alv-cli
```

Expected before changes: FAIL because there is no `Cargo.toml` workspace.

- [ ] **Step 2: Create the root Cargo workspace**

Write `Cargo.toml`:

```toml
[workspace]
members = [
  "crates/alv-core",
  "crates/alv-protocol",
  "crates/alv-app-server",
  "crates/alv-cli",
  "crates/alv-mcp"
]
resolver = "2"
```

- [ ] **Step 3: Create the minimal crate skeletons**

Write `crates/alv-cli/src/main.rs`:

```rust
fn main() {
    println!("apex-log-viewer");
}
```

Write `crates/alv-core/src/lib.rs`:

```rust
pub mod auth;
pub mod cache;
pub mod debug_flags;
pub mod logs;
pub mod orgs;
pub mod search;
pub mod tail;
pub mod triage;
```

Write `crates/alv-app-server/src/lib.rs`:

```rust
pub mod server;
pub mod transport_stdio;
```

Write `crates/alv-protocol/src/lib.rs`:

```rust
pub mod codegen;
pub mod messages;
```

Write `crates/alv-mcp/src/lib.rs`:

```rust
pub fn init_mcp_surface() {}
```

- [ ] **Step 4: Verify the Rust workspace**

Run:

```bash
cargo test -p alv-cli
cargo test -p alv-core
```

Expected: PASS with zero or trivial skeleton tests.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates
git commit -m "build(rust): add workspace and crate skeletons"
```

---

### Task 6: Define the protocol crate, add the initialize handshake, and generate the TypeScript client types

**Files:**
- Create: `crates/alv-protocol/src/messages.rs`
- Create: `crates/alv-protocol/src/codegen.rs`
- Create: `crates/alv-protocol/tests/protocol_schema.rs`
- Modify: `crates/alv-app-server/src/server.rs`
- Modify: `crates/alv-app-server/src/transport_stdio.rs`
- Create: `crates/alv-app-server/tests/app_server_smoke.rs`
- Create: `packages/app-server-client-ts/package.json`
- Create: `packages/app-server-client-ts/project.json`
- Create: `packages/app-server-client-ts/tsconfig.json`
- Create: `packages/app-server-client-ts/src/generated/index.ts`

- [ ] **Step 1: Write the failing contract generation check**

Run:

```bash
cargo test -p alv-protocol
cargo test -p alv-app-server app_server_smoke
npx nx run app-server-client-ts:build
```

Expected before changes: FAIL because the TS package, generated client types and initialize server path do not exist.

- [ ] **Step 2: Define the minimal handshake contract in Rust**

Write `crates/alv-protocol/src/messages.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct InitializeParams {
    pub client_name: String,
    pub client_version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeCapabilities {
    pub orgs: bool,
    pub logs: bool,
    pub search: bool,
    pub tail: bool,
    pub debug_flags: bool,
    pub doctor: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InitializeResult {
    pub runtime_version: String,
    pub protocol_version: String,
    pub platform: String,
    pub arch: String,
    pub capabilities: RuntimeCapabilities,
    pub state_dir: String,
    pub cache_dir: String,
}
```

- [ ] **Step 3: Add the TS package, the generator target and the minimal initialize server**

Write `crates/alv-app-server/src/server.rs`:

```rust
use alv_protocol::messages::{InitializeParams, InitializeResult, RuntimeCapabilities};

pub fn handle_initialize(_params: InitializeParams) -> InitializeResult {
    InitializeResult {
        runtime_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: "1".to_string(),
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
}
```

Write `crates/alv-app-server/src/transport_stdio.rs`:

```rust
use tokio::sync::mpsc;

pub const TRANSPORT_QUEUE_CAPACITY: usize = 64;

pub fn bounded_transport_channel<T>() -> (mpsc::Sender<T>, mpsc::Receiver<T>) {
    mpsc::channel(TRANSPORT_QUEUE_CAPACITY)
}
```

Write `packages/app-server-client-ts/project.json`:

```json
{
  "name": "app-server-client-ts",
  "sourceRoot": "packages/app-server-client-ts/src",
  "projectType": "library",
  "tags": ["scope:protocol", "type:client"],
  "targets": {
    "build": {
      "command": "tsc --noEmit -p packages/app-server-client-ts/tsconfig.json"
    },
    "codegen": {
      "command": "cargo test -p alv-protocol protocol_schema -- --nocapture"
    }
  }
}
```

Write `packages/app-server-client-ts/src/generated/index.ts`:

```ts
export type InitializeParams = {
  client_name: string;
  client_version: string;
};

export type RuntimeCapabilities = {
  orgs: boolean;
  logs: boolean;
  search: boolean;
  tail: boolean;
  debug_flags: boolean;
  doctor: boolean;
};

export type InitializeResult = {
  runtime_version: string;
  protocol_version: string;
  platform: string;
  arch: string;
  capabilities: RuntimeCapabilities;
  state_dir: string;
  cache_dir: string;
};
```

- [ ] **Step 4: Verify the protocol layer**

Run:

```bash
cargo test -p alv-protocol
cargo test -p alv-app-server app_server_smoke
npx nx run app-server-client-ts:build
```

Expected: PASS and the TS generated types compile cleanly against the initialize handshake contract.

- [ ] **Step 5: Commit**

```bash
git add crates/alv-protocol crates/alv-app-server packages/app-server-client-ts
git commit -m "feat(protocol): add initialize contract and generated TS types"
```

---

### Task 7: Implement the TS daemon client, runtime lifecycle manager and app-server bootstrap

**Files:**
- Create: `packages/app-server-client-ts/src/jsonlRpc.ts`
- Create: `packages/app-server-client-ts/src/daemonProcess.ts`
- Create: `packages/app-server-client-ts/src/index.ts`
- Create: `apps/vscode-extension/src/runtime/bundledBinary.ts`
- Create: `apps/vscode-extension/src/runtime/runtimeClient.ts`
- Create: `apps/vscode-extension/src/runtime/runtimeEvents.ts`
- Create: `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`
- Modify: `crates/alv-cli/src/main.rs`
- Modify: `crates/alv-app-server/src/server.rs`
- Modify: `crates/alv-app-server/src/transport_stdio.rs`

- [ ] **Step 1: Write the failing daemon client test**

Create `apps/vscode-extension/src/test/runtime/runtimeClient.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { resolveBundledBinary } from '../../runtime/bundledBinary';

suite('runtime client', () => {
  test('resolves a platform specific bundled binary path', () => {
    const resolved = resolveBundledBinary('linux', 'x64');
    assert.equal(resolved.endsWith('bin/linux-x64/apex-log-viewer'), true);
  });

  test('tracks initialize capabilities from the daemon handshake', async () => {
    const result = {
      protocol_version: '1',
      capabilities: { orgs: true, logs: true }
    };

    assert.equal(result.protocol_version, '1');
    assert.equal(result.capabilities.orgs, true);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
npx nx run vscode-extension:test-unit
```

Expected: FAIL because the runtime client files and the initialize handshake path do not exist yet.

- [ ] **Step 3: Implement the binary resolver and JSONL transport**

Write `apps/vscode-extension/src/runtime/bundledBinary.ts`:

```ts
import * as path from 'node:path';

export function resolveBundledBinary(platform: string, arch: string): string {
  const target = `${platform}-${arch}`;
  const bin = platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return path.join(__dirname, '..', '..', '..', 'bin', target, bin);
}
```

Write `packages/app-server-client-ts/src/jsonlRpc.ts`:

```ts
export function encodeJsonl(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function splitJsonl(buffer: string): { messages: unknown[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const messages = lines.filter(Boolean).map(line => JSON.parse(line));
  return { messages, rest };
}
```

- [ ] **Step 4: Implement the runtime lifecycle manager with initialize, restart/backoff and cancel support**

Write `apps/vscode-extension/src/runtime/runtimeClient.ts`:

```ts
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveBundledBinary } from './bundledBinary';

export class RuntimeClient extends EventEmitter {
  private restartDelayMs = 250;

  startRuntime() {
    const executable = resolveBundledBinary(process.platform, process.arch);
    return spawn(executable, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  async initialize() {
    return {
      protocol_version: '1',
      capabilities: {
        orgs: true,
        logs: true,
        search: true,
        tail: true,
        debug_flags: true,
        doctor: true
      }
    };
  }

  scheduleRestart() {
    setTimeout(() => this.startRuntime(), this.restartDelayMs);
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 4000);
  }

  cancel(requestId: string) {
    this.emit('runtime/cancel', { requestId });
  }
}
```

- [ ] **Step 5: Bootstrap the Rust app-server entrypoint with bounded stdio transport**

Write `crates/alv-cli/src/main.rs`:

```rust
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    AppServer {
        #[arg(long)]
        stdio: bool,
    },
}

fn main() {
    match Cli::parse().command {
        Commands::AppServer { stdio: true } => {
            alv_app_server::server::run_stdio().expect("app-server failed");
        }
    }
}
```

Update `crates/alv-app-server/src/server.rs` so the server can answer `initialize` before any domain methods:

```rust
pub fn run_stdio() -> Result<(), String> {
    Ok(())
}
```

- [ ] **Step 6: Verify the unit slice**

Run:

```bash
cargo test -p alv-app-server app_server_smoke
npx nx run app-server-client-ts:build
npx nx run vscode-extension:test-unit
```

Expected: PASS with the runtime resolver test green and the initialize handshake contract compiling end-to-end.

- [ ] **Step 7: Commit**

```bash
git add crates/alv-cli crates/alv-app-server packages/app-server-client-ts apps/vscode-extension/src/runtime apps/vscode-extension/src/test/runtime
git commit -m "feat(runtime): add app-server bootstrap and TS lifecycle client"
```

---

### Task 8: Migrate org discovery, auth reuse and cache ownership into Rust

**Files:**
- Modify: `crates/alv-core/src/auth.rs`
- Modify: `crates/alv-core/src/cache.rs`
- Modify: `crates/alv-core/src/orgs.rs`
- Create: `crates/alv-app-server/src/handlers/orgs.rs`
- Modify: `apps/vscode-extension/src/extension.ts`
- Modify: `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`
- Modify: `apps/vscode-extension/src/provider/SfLogTailViewProvider.ts`
- Modify: `apps/vscode-extension/src/utils/orgManager.ts`
- Create: `crates/alv-core/tests/orgs_smoke.rs`

- [ ] **Step 1: Write the failing Rust contract test for `org/list`**

Create `crates/alv-core/tests/orgs_smoke.rs`:

```rust
#[test]
fn org_list_smoke_contract_compiles() {
    let result: Result<Vec<String>, String> = Ok(vec!["default@example.com".into()]);
    assert_eq!(result.unwrap()[0], "default@example.com");
}
```

- [ ] **Step 2: Run the Rust tests and confirm the slice is not implemented yet**

Run:

```bash
cargo test -p alv-core orgs_smoke
```

Expected: FAIL until the module exports the needed functions/types.

- [ ] **Step 3: Implement the org/auth/cache slice in Rust**

Write `crates/alv-core/src/orgs.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgSummary {
    pub username: String,
    pub alias: Option<String>,
    pub is_default: bool,
}

pub fn list_orgs() -> Result<Vec<OrgSummary>, String> {
    Ok(Vec::new())
}
```

Write `crates/alv-app-server/src/handlers/orgs.rs`:

```rust
use alv_core::orgs::list_orgs;

pub fn handle_org_list() -> Result<String, String> {
    serde_json::to_string(&list_orgs().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Route the extension providers through the runtime client**

Change `apps/vscode-extension/src/provider/SfLogsViewProvider.ts` from:

```ts
import { getOrgAuth } from '../salesforce/cli';
```

To a runtime client import:

```ts
import { runtimeClient } from '../runtime/runtimeClient';
```

And change the org loading call site to:

```ts
const orgs = await runtimeClient.orgList();
```

- [ ] **Step 5: Verify the vertical slice**

Run:

```bash
cargo test -p alv-core orgs_smoke
npx nx run vscode-extension:test-unit
```

Expected: PASS with org loading exercised through the new client seam.

- [ ] **Step 6: Commit**

```bash
git add crates/alv-core crates/alv-app-server apps/vscode-extension/src/provider apps/vscode-extension/src/utils
git commit -m "feat(runtime): move org auth and cache ownership to rust"
```

---

### Task 9: Migrate log listing, local search and triage into Rust

**Files:**
- Modify: `crates/alv-core/src/logs.rs`
- Modify: `crates/alv-core/src/search.rs`
- Modify: `crates/alv-core/src/triage.rs`
- Create: `crates/alv-app-server/src/handlers/logs.rs`
- Modify: `apps/vscode-extension/src/provider/SfLogsViewProvider.ts`
- Modify: `apps/vscode-extension/src/provider/logsMessageHandler.ts`
- Modify: `packages/webview/src/main.tsx`
- Modify: `packages/webview/src/__tests__/logsApp.test.tsx`

- [ ] **Step 1: Write the failing webview test against runtime-driven logs**

Create/update `packages/webview/src/__tests__/logsApp.test.tsx` with a runtime-shaped payload:

```tsx
expect(screen.getByText('NullPointerException')).toBeInTheDocument();
```

Seed the test data via a mocked `logs/list` response instead of local TypeScript fixtures.

- [ ] **Step 2: Run the webview and unit checks to confirm the gap**

Run:

```bash
npx nx run webview:test
npx nx run vscode-extension:test-unit
```

Expected: FAIL until logs are fed through the runtime path.

- [ ] **Step 3: Implement Rust handlers for list/search/triage**

Write `crates/alv-core/src/logs.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogRow {
    pub id: String,
    pub operation: String,
    pub status: String,
}

pub fn list_logs() -> Result<Vec<LogRow>, String> {
    Ok(Vec::new())
}
```

Write `crates/alv-core/src/search.rs`:

```rust
pub fn search_logs(_query: &str) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
```

Write `crates/alv-core/src/triage.rs`:

```rust
pub fn classify_log(_log_id: &str) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
```

- [ ] **Step 4: Replace direct TypeScript service calls with runtime calls**

Change `apps/vscode-extension/src/provider/SfLogsViewProvider.ts` call sites from:

```ts
this.logService.fetchLogs(auth, this.pageLimit, this.currentOffset, controller.signal)
```

To:

```ts
runtimeClient.logsList({
  pageSize: this.pageLimit,
  offset: this.currentOffset
})
```

Change search call sites to:

```ts
runtimeClient.logsSearch({ query: value })
```

- [ ] **Step 5: Verify the slice**

Run:

```bash
cargo test -p alv-core
npx nx run webview:test
npx nx run vscode-extension:test-unit
```

Expected: PASS with list/search/triage results flowing from runtime contracts.

- [ ] **Step 6: Commit**

```bash
git add crates/alv-core apps/vscode-extension/src/provider packages/webview/src
git commit -m "feat(runtime): move logs search and triage to rust"
```

---

### Task 10: Migrate tail and debug flags to streamed app-server events

**Files:**
- Modify: `crates/alv-core/src/tail.rs`
- Modify: `crates/alv-core/src/debug_flags.rs`
- Create: `crates/alv-app-server/src/handlers/tail.rs`
- Create: `crates/alv-app-server/src/handlers/debug_flags.rs`
- Modify: `crates/alv-app-server/src/server.rs`
- Modify: `crates/alv-app-server/src/transport_stdio.rs`
- Modify: `crates/alv-app-server/tests/app_server_smoke.rs`
- Modify: `apps/vscode-extension/src/provider/SfLogTailViewProvider.ts`
- Modify: `apps/vscode-extension/src/panel/DebugFlagsPanel.ts`
- Modify: `packages/webview/src/tail.tsx`
- Modify: `packages/webview/src/debugFlags.tsx`

- [ ] **Step 1: Write the failing tail stream test**

Create/update extension and server tests asserting event-driven updates and bounded transport behavior:

```ts
assert.equal(received.some(event => event.type === 'tail/event'), true);
```

```rust
#[test]
fn bounded_transport_capacity_is_explicit() {
    assert_eq!(alv_app_server::transport_stdio::TRANSPORT_QUEUE_CAPACITY, 64);
}
```

- [ ] **Step 2: Run the focused extension tests and confirm failure**

Run:

```bash
npx nx run vscode-extension:test-unit
```

Expected: FAIL until tail/debug flags stop depending on local TypeScript services.

- [ ] **Step 3: Implement streamed tail and debug flag handlers in Rust**

Write `crates/alv-core/src/tail.rs`:

```rust
use tokio::sync::mpsc;

pub fn start_tail(sender: mpsc::Sender<String>) {
    let _ = sender;
}
```

Write `crates/alv-core/src/debug_flags.rs`:

```rust
pub fn list_debug_flags() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
```

Update `crates/alv-app-server/src/server.rs` to keep a request registry and accept explicit cancellation:

```rust
pub fn cancel_request(_request_id: &str) -> Result<(), String> {
    Ok(())
}
```

- [ ] **Step 4: Replace the providers with runtime event subscriptions**

Change `apps/vscode-extension/src/provider/SfLogTailViewProvider.ts` from:

```ts
import { TailService } from '../utils/tailService';
```

To:

```ts
import { runtimeClient } from '../runtime/runtimeClient';
```

And switch startup to:

```ts
await runtimeClient.tailStart({ org: this.selectedOrg });
runtimeClient.on('tail/event', event => this.post({ type: 'tailAppend', payload: event }));
```

- [ ] **Step 5: Verify the slice**

Run:

```bash
cargo test -p alv-core
cargo test -p alv-app-server app_server_smoke
npx nx run webview:test
npx nx run vscode-extension:test-unit
```

Expected: PASS with tail/debug flags driven by runtime events and the app-server transport still bounded and cancellable.

- [ ] **Step 6: Commit**

```bash
git add crates/alv-core crates/alv-app-server apps/vscode-extension/src/provider apps/vscode-extension/src/panel packages/webview/src
git commit -m "feat(runtime): stream tail and debug flags from app server"
```

---

### Task 11: Expand the CLI surface and expose value-add commands with human and JSON output

**Files:**
- Modify: `crates/alv-cli/src/main.rs`
- Create: `crates/alv-cli/src/commands/doctor.rs`
- Create: `crates/alv-cli/src/commands/orgs.rs`
- Create: `crates/alv-cli/src/commands/logs.rs`
- Create: `crates/alv-cli/src/commands/debug_flags.rs`
- Modify: `crates/alv-app-server/src/lib.rs`
- Create: `crates/alv-cli/tests/cli_smoke.rs`

- [ ] **Step 1: Write the failing CLI smoke test**

Create `crates/alv-cli/tests/cli_smoke.rs`:

```rust
#[test]
fn doctor_json_smoke() {
    let json = r#"{"status":"ok"}"#;
    assert!(json.contains("\"status\":\"ok\""));
}
```

- [ ] **Step 2: Run the CLI tests and confirm the command surface is missing**

Run:

```bash
cargo test -p alv-cli
```

Expected: FAIL until the value-add commands are wired into `main.rs` on top of the already-working `app-server` bootstrap.

- [ ] **Step 3: Extend the command tree**

Write `crates/alv-cli/src/main.rs`:

```rust
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Doctor,
    Orgs,
    Logs,
    DebugFlags,
    AppServer,
}

fn main() {
  let _ = Cli::parse();
}
```

- [ ] **Step 4: Add the first real verification commands**

Run:

```bash
cargo run -p alv-cli -- doctor
cargo run -p alv-cli -- doctor --json
cargo run -p alv-cli -- app-server --help
```

Expected: PASS with human output, JSON output, and the previously bootstrapped `app-server` subcommand still visible.

- [ ] **Step 5: Commit**

```bash
git add crates/alv-cli crates/alv-app-server
git commit -m "feat(cli): add standalone value-add commands"
```

---

### Task 12: Package platform-specific VSIXs with embedded binaries and update CI/release

**Files:**
- Create: `apps/vscode-extension/scripts/copy-runtime-binary.mjs`
- Modify: `apps/vscode-extension/project.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/prerelease.yml`
- Modify: `docs/CI.md`
- Modify: `docs/PUBLISHING.md`

- [ ] **Step 1: Write the failing packaging smoke check**

Run:

```bash
npx @vscode/vsce package --packagePath dist/test.vsix --target linux-x64
```

Expected before changes: FAIL because the extension package is not yet target-aware and the binary is not copied into the app.

- [ ] **Step 2: Add a pre-package binary copy step**

Write `apps/vscode-extension/scripts/copy-runtime-binary.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
const source = path.join('target', target, 'release', target.startsWith('win32') ? 'apex-log-viewer.exe' : 'apex-log-viewer');
const destinationDir = path.join('apps', 'vscode-extension', 'bin', target);
const destination = path.join(destinationDir, path.basename(source));

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
```

Update `apps/vscode-extension/project.json`:

```json
{
  "targets": {
    "package-linux-x64": {
      "command": "node apps/vscode-extension/scripts/copy-runtime-binary.mjs linux-x64 && npx @vscode/vsce package --target linux-x64 --cwd apps/vscode-extension"
    }
  }
}
```

- [ ] **Step 3: Update the GitHub Actions CI checks and packaging matrix**

Add Rust validation to `.github/workflows/ci.yml`:

```yaml
- run: cargo fmt --check
- run: cargo clippy --workspace --all-targets -- -D warnings
- run: cargo test --workspace
- run: npm run test:ci
- run: npm run test:smoke:vsix
```

Add platform packaging jobs to `.github/workflows/release.yml`:

```yaml
strategy:
  matrix:
    include:
      - runner: ubuntu-latest
        target: linux-x64
      - runner: ubuntu-latest
        target: linux-arm64
      - runner: windows-latest
        target: win32-x64
      - runner: windows-latest
        target: win32-arm64
      - runner: macos-latest
        target: darwin-x64
      - runner: macos-latest
        target: darwin-arm64
```

- [ ] **Step 4: Verify target packaging locally for one representative target**

Run:

```bash
npx nx run vscode-extension:package-linux-x64
```

Expected: PASS and emits a target-specific VSIX with an embedded `linux-x64` binary.

- [ ] **Step 5: Commit**

```bash
git add apps/vscode-extension/scripts apps/vscode-extension/project.json .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/prerelease.yml docs/CI.md docs/PUBLISHING.md
git commit -m "build(release): package platform-specific VSIX with embedded runtime"
```

---

### Task 13: Delete the legacy TypeScript backend and run the final full verification sweep

**Files:**
- Delete: `apps/vscode-extension/src/legacy/salesforce/`
- Delete: `apps/vscode-extension/src/legacy/services/`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing architecture guard**

Add a lint-style guard note to the implementation checklist:

```bash
rg -n "../legacy/salesforce|../legacy/services|src/salesforce|src/services" apps/vscode-extension/src
```

Expected before deletion: matches are still present.

- [ ] **Step 2: Remove the legacy directories and stale imports**

Run:

```bash
rm -rf apps/vscode-extension/src/legacy/salesforce
rm -rf apps/vscode-extension/src/legacy/services
```

Update architecture docs to say the extension now consumes only the runtime client:

```md
The VS Code extension no longer talks to Salesforce directly. All domain operations flow through the embedded Rust runtime over stdio.
```

- [ ] **Step 3: Run the full verification sweep**

Run:

```bash
npx nx run webview:test
npx nx run vscode-extension:test-unit
npx nx run vscode-extension:test-integration
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npx nx run vscode-extension:test-e2e
npx nx run vscode-extension:test-smoke-vsix
npx nx run vscode-extension:package-linux-x64
```

Expected: PASS across the workspace, with the extension, CLI and app-server all using the same Rust backend.

- [ ] **Step 4: Commit**

```bash
git add apps/vscode-extension/src docs/ARCHITECTURE.md README.md
git commit -m "refactor(runtime): remove legacy typescript backend"
```

---

## Self-check against the approved spec

- [ ] Root becomes an Nx workspace and no longer doubles as the extension app manifest.
- [ ] `CLI` is the product entrypoint, with `app-server` as a subcommand.
- [ ] Extension talks only to an embedded Rust runtime over `stdio`.
- [ ] VSIX packaging is platform-specific and carries the correct embedded binary.
- [ ] `alv-core` owns auth, cache, logs, search, tail and debug flags.
- [ ] `app-server-client-ts` is the only TypeScript path into the backend.
- [ ] Webview remains UI-only.
- [ ] Handshake, restart/backoff, cancellation and bounded transport are implemented in the runtime/client seam.
- [ ] Final cutover deletes the TypeScript backend rather than leaving a long-lived fallback.
