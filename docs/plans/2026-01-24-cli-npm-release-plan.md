# CLI NPM Release CI Implementation Plan

> **For the agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the Rust CLI to npm using platform-specific packages plus a wrapper package, driven by a secure GitHub Actions workflow.

**Architecture:** A wrapper npm package (`@electivus/apex-log-viewer-cli`) depends on six optional platform packages. Each platform package ships the compiled Rust binary. A CI workflow builds targets, packages them, publishes the platform packages first, then publishes the wrapper.

**Tech Stack:** Rust (cargo), Node.js (packaging scripts), npm publish with provenance, GitHub Actions.

---

### Task 1: Add platform resolver module + tests for wrapper

**Files:**
- Create: `scripts/cli-npm/resolve-platform.test.cjs`
- Create: `crates/cli/npm/wrapper/lib/resolve-platform.cjs`
- Create: `crates/cli/npm/wrapper/bin/apex-log-viewer.js`

**Step 1: Write the failing test**
Create `scripts/cli-npm/resolve-platform.test.cjs`:
```js
const assert = require('assert');
const { resolvePlatform } = require('../../crates/cli/npm/wrapper/lib/resolve-platform.cjs');

assert.deepStrictEqual(resolvePlatform('linux', 'x64'), {
  packageName: '@electivus/apex-log-viewer-cli-linux-x64',
  binName: 'apex-log-viewer'
});
assert.deepStrictEqual(resolvePlatform('darwin', 'arm64'), {
  packageName: '@electivus/apex-log-viewer-cli-darwin-arm64',
  binName: 'apex-log-viewer'
});
assert.deepStrictEqual(resolvePlatform('win32', 'x64'), {
  packageName: '@electivus/apex-log-viewer-cli-win32-x64',
  binName: 'apex-log-viewer.exe'
});
assert.throws(() => resolvePlatform('freebsd', 'x64'));
console.log('resolve-platform ok');
```

**Step 2: Run test to verify it fails**
Run: `node scripts/cli-npm/resolve-platform.test.cjs`
Expected: FAIL with "Cannot find module .../resolve-platform.cjs".

**Step 3: Write minimal implementation**
Create `crates/cli/npm/wrapper/lib/resolve-platform.cjs`:
```js
const MAP = new Map([
  ['linux:x64', { packageName: '@electivus/apex-log-viewer-cli-linux-x64', binName: 'apex-log-viewer' }],
  ['linux:arm64', { packageName: '@electivus/apex-log-viewer-cli-linux-arm64', binName: 'apex-log-viewer' }],
  ['darwin:x64', { packageName: '@electivus/apex-log-viewer-cli-darwin-x64', binName: 'apex-log-viewer' }],
  ['darwin:arm64', { packageName: '@electivus/apex-log-viewer-cli-darwin-arm64', binName: 'apex-log-viewer' }],
  ['win32:x64', { packageName: '@electivus/apex-log-viewer-cli-win32-x64', binName: 'apex-log-viewer.exe' }],
  ['win32:arm64', { packageName: '@electivus/apex-log-viewer-cli-win32-arm64', binName: 'apex-log-viewer.exe' }]
]);

function resolvePlatform(platform, arch) {
  const key = `${platform}:${arch}`;
  const match = MAP.get(key);
  if (!match) {
    throw new Error(`Unsupported platform ${platform}/${arch}`);
  }
  return match;
}

module.exports = { resolvePlatform };
```

Create `crates/cli/npm/wrapper/bin/apex-log-viewer.js`:
```js
#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const { resolvePlatform } = require('../lib/resolve-platform.cjs');

function main() {
  const { packageName, binName } = resolvePlatform(process.platform, process.arch);
  const pkgRoot = path.dirname(require.resolve(`${packageName}/package.json`));
  const binPath = path.join(pkgRoot, 'bin', binName);
  const result = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

main();
```

**Step 4: Run test to verify it passes**
Run: `node scripts/cli-npm/resolve-platform.test.cjs`
Expected: PASS with "resolve-platform ok".

**Step 5: Commit**
```bash
git add scripts/cli-npm/resolve-platform.test.cjs crates/cli/npm/wrapper/lib/resolve-platform.cjs crates/cli/npm/wrapper/bin/apex-log-viewer.js
git commit -m "feat(cli): add npm wrapper platform resolver"
```

---

### Task 2: Add npm package templates for wrapper + platform

**Files:**
- Create: `crates/cli/npm/wrapper/package.json`
- Create: `crates/cli/npm/wrapper/README.md`
- Create: `crates/cli/npm/platform/package.json`
- Create: `crates/cli/npm/platform/README.md`
- Create: `scripts/cli-npm/validate-templates.test.cjs`

**Step 1: Write the failing test**
Create `scripts/cli-npm/validate-templates.test.cjs`:
```js
const assert = require('assert');
const path = require('path');

const wrapperPkg = require(path.resolve('crates/cli/npm/wrapper/package.json'));
const platformPkg = require(path.resolve('crates/cli/npm/platform/package.json'));

assert.ok(wrapperPkg.name === '@electivus/apex-log-viewer-cli');
assert.ok(wrapperPkg.bin && wrapperPkg.bin['apex-log-viewer']);
assert.ok(Array.isArray(wrapperPkg.files));

assert.ok(platformPkg.name.includes('@electivus/apex-log-viewer-cli-'));
assert.ok(Array.isArray(platformPkg.files));
assert.ok(platformPkg.os && platformPkg.cpu);

console.log('templates ok');
```

**Step 2: Run test to verify it fails**
Run: `node scripts/cli-npm/validate-templates.test.cjs`
Expected: FAIL with "Cannot find module .../package.json".

**Step 3: Write minimal templates**
Create `crates/cli/npm/wrapper/package.json`:
```json
{
  "name": "@electivus/apex-log-viewer-cli",
  "version": "0.0.0",
  "private": false,
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Electivus/Apex-Log-Viewer"
  },
  "bin": {
    "apex-log-viewer": "bin/apex-log-viewer.js"
  },
  "files": ["bin/**", "lib/**"],
  "optionalDependencies": {}
}
```

Create `crates/cli/npm/wrapper/README.md`:
```md
# Apex Log Viewer CLI

Install with `npm i -g @electivus/apex-log-viewer-cli`.
```

Create `crates/cli/npm/platform/package.json`:
```json
{
  "name": "@electivus/apex-log-viewer-cli-__PLATFORM__",
  "version": "0.0.0",
  "private": false,
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Electivus/Apex-Log-Viewer"
  },
  "os": ["__OS__"],
  "cpu": ["__CPU__"],
  "bin": {
    "apex-log-viewer": "bin/__BIN__"
  },
  "files": ["bin/**"]
}
```

Create `crates/cli/npm/platform/README.md`:
```md
# Apex Log Viewer CLI (Platform)

This package is installed automatically by the main wrapper.
```

**Step 4: Run test to verify it passes**
Run: `node scripts/cli-npm/validate-templates.test.cjs`
Expected: PASS with "templates ok".

**Step 5: Commit**
```bash
git add crates/cli/npm/wrapper crates/cli/npm/platform scripts/cli-npm/validate-templates.test.cjs
git commit -m "chore(cli): add npm package templates"
```

---

### Task 3: Add packaging scripts for platform packages and wrapper

**Files:**
- Create: `scripts/cli-npm/read-version.mjs`
- Create: `scripts/cli-npm/package-platform.mjs`
- Create: `scripts/cli-npm/package-wrapper.mjs`
- Create: `scripts/cli-npm/read-version.test.cjs`

**Step 1: Write the failing test**
Create `scripts/cli-npm/read-version.test.cjs`:
```js
const assert = require('assert');
const { readCargoVersion } = require('./read-version.mjs');

const version = readCargoVersion('scripts/cli-npm/fixtures/Cargo.toml');
assert.strictEqual(version, '1.2.3');
console.log('version ok');
```
Also create `scripts/cli-npm/fixtures/Cargo.toml`:
```toml
[package]
name = "fake"
version = "1.2.3"
```

**Step 2: Run test to verify it fails**
Run: `node scripts/cli-npm/read-version.test.cjs`
Expected: FAIL with "Cannot find module './read-version.mjs'".

**Step 3: Write minimal implementation**
Create `scripts/cli-npm/read-version.mjs`:
```js
import fs from 'fs';

export function readCargoVersion(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error('version not found');
  }
  return match[1];
}
```

Create `scripts/cli-npm/package-platform.mjs`:
```js
import fs from 'fs';
import path from 'path';
import { readCargoVersion } from './read-version.mjs';

const [,, targetTriple, platformName, os, cpu, binName, binaryPath, outDir] = process.argv;
if (!targetTriple || !platformName || !os || !cpu || !binName || !binaryPath || !outDir) {
  throw new Error('usage: package-platform <target> <platform> <os> <cpu> <bin> <binaryPath> <outDir>');
}
const version = readCargoVersion('crates/cli/Cargo.toml');
const templateDir = 'crates/cli/npm/platform';
const pkgDir = path.join(outDir, platformName);
fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
const pkgJson = JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'));
const patched = JSON.stringify({
  ...pkgJson,
  name: `@electivus/apex-log-viewer-cli-${platformName}`,
  version,
  os: [os],
  cpu: [cpu],
  bin: { 'apex-log-viewer': `bin/${binName}` }
}, null, 2);
fs.writeFileSync(path.join(pkgDir, 'package.json'), patched + '\n');
fs.copyFileSync(path.join(templateDir, 'README.md'), path.join(pkgDir, 'README.md'));
fs.copyFileSync('LICENSE', path.join(pkgDir, 'LICENSE'));
fs.copyFileSync(binaryPath, path.join(pkgDir, 'bin', binName));
```

Create `scripts/cli-npm/package-wrapper.mjs`:
```js
import fs from 'fs';
import path from 'path';
import { readCargoVersion } from './read-version.mjs';

const [,, outDir, ...platforms] = process.argv;
if (!outDir || platforms.length === 0) {
  throw new Error('usage: package-wrapper <outDir> <platformName...>');
}
const version = readCargoVersion('crates/cli/Cargo.toml');
const templateDir = 'crates/cli/npm/wrapper';
const pkgDir = path.join(outDir, 'wrapper');
fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
const pkgJson = JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'));
const optionalDeps = Object.fromEntries(
  platforms.map((p) => [`@electivus/apex-log-viewer-cli-${p}`, version])
);
const patched = JSON.stringify({
  ...pkgJson,
  version,
  optionalDependencies: optionalDeps
}, null, 2);
fs.writeFileSync(path.join(pkgDir, 'package.json'), patched + '\n');
fs.copyFileSync(path.join(templateDir, 'README.md'), path.join(pkgDir, 'README.md'));
fs.copyFileSync('LICENSE', path.join(pkgDir, 'LICENSE'));
fs.copyFileSync(path.join(templateDir, 'bin', 'apex-log-viewer.js'), path.join(pkgDir, 'bin', 'apex-log-viewer.js'));
fs.copyFileSync(path.join(templateDir, 'lib', 'resolve-platform.cjs'), path.join(pkgDir, 'lib', 'resolve-platform.cjs'));
```

**Step 4: Run test to verify it passes**
Run: `node scripts/cli-npm/read-version.test.cjs`
Expected: PASS with "version ok".

**Step 5: Commit**
```bash
git add scripts/cli-npm/read-version.mjs scripts/cli-npm/package-platform.mjs scripts/cli-npm/package-wrapper.mjs scripts/cli-npm/read-version.test.cjs scripts/cli-npm/fixtures/Cargo.toml
git commit -m "chore(cli): add npm packaging scripts"
```

---

### Task 4: Add GitHub Actions workflow to build and publish npm packages

**Files:**
- Create: `.github/workflows/cli-npm-release.yml`
- Create: `scripts/cli-npm/validate-workflow.test.cjs`

**Step 1: Write the failing test**
Create `scripts/cli-npm/validate-workflow.test.cjs`:
```js
const assert = require('assert');
const fs = require('fs');

const text = fs.readFileSync('.github/workflows/cli-npm-release.yml', 'utf8');
assert.ok(text.includes('cli-v*'));
assert.ok(text.includes('npm publish'));
assert.ok(text.includes('id-token: write'));
console.log('workflow ok');
```

**Step 2: Run test to verify it fails**
Run: `node scripts/cli-npm/validate-workflow.test.cjs`
Expected: FAIL with "ENOENT".

**Step 3: Write minimal workflow**
Create `.github/workflows/cli-npm-release.yml` with:
- `on: push: tags: ['cli-v*']` and `workflow_dispatch`.
- `permissions: contents: read, id-token: write`.
- Build matrix for targets (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64).
- Steps: checkout, setup Rust, setup Node, verify tag matches `crates/cli/Cargo.toml` version, build target, run `node scripts/cli-npm/package-platform.mjs ...`, then `npm publish --provenance` for each platform package.
- Final job publishes wrapper with `node scripts/cli-npm/package-wrapper.mjs` and `npm publish --provenance`.

**Step 4: Run test to verify it passes**
Run: `node scripts/cli-npm/validate-workflow.test.cjs`
Expected: PASS with "workflow ok".

**Step 5: Commit**
```bash
git add .github/workflows/cli-npm-release.yml scripts/cli-npm/validate-workflow.test.cjs
git commit -m "ci(cli): publish npm packages on tag"
```

---

### Task 5: Document CLI npm release flow

**Files:**
- Modify: `docs/CI.md`
- Modify: `docs/PUBLISHING.md`

**Step 1: Write the failing test**
Create `scripts/cli-npm/validate-docs.test.cjs`:
```js
const assert = require('assert');
const fs = require('fs');

const ci = fs.readFileSync('docs/CI.md', 'utf8');
const pub = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
assert.ok(ci.includes('cli-v'));
assert.ok(pub.includes('NPM_TOKEN'));
console.log('docs ok');
```

**Step 2: Run test to verify it fails**
Run: `node scripts/cli-npm/validate-docs.test.cjs`
Expected: FAIL with assertion error.

**Step 3: Update docs**
- Add a CI section for CLI npm publishing, tag format `cli-vX.Y.Z`, and required secret `NPM_TOKEN`.
- Document how to publish the CLI via tag and what the wrapper/platform packages are.

**Step 4: Run test to verify it passes**
Run: `node scripts/cli-npm/validate-docs.test.cjs`
Expected: PASS with "docs ok".

**Step 5: Commit**
```bash
git add docs/CI.md docs/PUBLISHING.md scripts/cli-npm/validate-docs.test.cjs
git commit -m "docs: document CLI npm publishing"
```
