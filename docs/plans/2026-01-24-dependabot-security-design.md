# Dependabot Security Fixes Design

**Goal:** Resolve all open Dependabot security alerts by updating vulnerable transitive npm dependencies to patched versions without introducing breaking changes.

## Context
- Monorepo with npm workspaces; lockfiles exist at repo root and `apps/vscode-extension/`.
- Dependabot alerts reference both lockfiles.
- Vulnerable packages and patched versions:
  - lodash -> 4.17.23
  - qs -> 6.14.1
  - glob -> 10.5.0 and/or 11.1.0
  - js-yaml -> 3.14.2 and 4.1.1

## Approach
- Use patch-only updates within existing semver ranges to avoid manifest changes.
- Update the extension workspace lockfile first, then refresh the root lockfile to align with workspace resolution.
- Avoid `npm audit fix --force` to prevent unexpected breaking changes.

## Implementation Outline
1. In `apps/vscode-extension`, run targeted `npm update lodash qs glob js-yaml`.
2. At repo root, run `npm install` to sync the root `package-lock.json`.
3. Verify resolved versions with `npm ls` at both root and extension workspace.
4. Run `npm --prefix apps/vscode-extension run test:webview -- --ci --runInBand` as a focused regression check.

## Risk Controls
- If a patched version cannot be reached via current semver ranges, stop and choose between:
  - Bumping the top-level dependency that pins the range, or
  - Adding an npm `overrides` entry (last resort).
- Keep diffs limited to lockfiles unless a manifest bump is required.

## Success Criteria
- No vulnerable versions of lodash, qs, glob, or js-yaml in either lockfile.
- Dependabot alerts for those packages close or are resolved by lockfile verification.
- Webview test suite passes.
