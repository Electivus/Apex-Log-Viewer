# Reverse Monorepo Design

## Context

The repository was converted to a monorepo with:
- VS Code extension under `apps/vscode-extension/`
- Rust CLI under `crates/cli/`
- CI/CD and tooling updated to the monorepo layout.

The new requirement is to fully undo the monorepo structure, return to a single-repo extension layout at root, and remove the CLI entirely with no backup.

## Decision

Adopt a hard structural reset:
- Use `apps/vscode-extension/` as the source of truth for extension files.
- Move extension project files back to repository root.
- Remove all Rust CLI artifacts and workflows.
- Rewrite CI/CD to run from root paths only.

## Scope

In scope:
- Root project structure and package metadata
- GitHub workflows and Dependabot config
- VS Code launch/tasks configs
- Repository docs that mention monorepo or CLI

Out of scope:
- Recovering CLI history or preserving CLI build/publish paths
- Data migration or backup for removed CLI assets

## Target Architecture

Single project repository at root:
- Extension source and tests under `src/` and `test/`
- Single `package.json` and `package-lock.json` at root
- All workflows operating from root
- No Cargo workspace, no Rust crates, no CLI npm packaging scripts

## Risks and Mitigations

- Risk: stale path references (`apps/vscode-extension`, `crates/cli`) can break CI.
  - Mitigation: global search after edits and workflow sanity checks.
- Risk: release/prerelease jobs can fail if working directories are not updated consistently.
  - Mitigation: patch all path-anchored lines (cache paths, artifact paths, package version reads).
- Risk: local dev launch/tasks fail due to old extension paths.
  - Mitigation: update `.vscode/tasks.json` and `.vscode/launch.json`.

## Validation Strategy

- `npm ci`
- `npm run build`
- `npm run test:webview -- --runInBand` (fast sanity)
- `npm run test:unit:ci` (if environment supports VS Code host)
- `rg` sweep for residual monorepo/CLI references in active files.
