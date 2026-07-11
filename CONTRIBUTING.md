# Contributing to Apex Log Viewer

Thanks for taking the time to contribute! This guide covers local setup, coding standards, Conventional Commits, and our tag‑based release process.

## Quick Start

- Requirements: Node.js 24.15.0+ (use `nvm use` to respect `.nvmrc`), VS Code 1.90+, Salesforce CLI (`sf` recommended or legacy `sfdx`).
- Clone and install: `pnpm install --frozen-lockfile`
- Build once: `pnpm run build`
- Dev mode: `pnpm run watch` then press `F5` in VS Code to launch the Extension Development Host.
- Tests: `pnpm test` (runs type-check, lint, and VS Code tests).
- Lint/format: `pnpm run lint` and `pnpm run format`.

Helpful scripts:

- `pnpm run watch` – parallel watch for extension, types, and webview; use VS Code `F5`.
- `pnpm run build` – compile the extension and bundle the webview.
- `pnpm test` – compiles tests and runs VS Code tests.

## Coding Style

- TypeScript strict mode; 2-space indent; include semicolons.
- ESLint enforced: `curly`, `eqeqeq`, `no-throw-literal`; fix warnings before PRs.
- Names: PascalCase for React components/classes; camelCase for functions/vars.
- Files: webview components under `packages/webview/src/components/`; extension-only utilities under `apps/vscode-extension/src/host/`; shared business behavior under `packages/core/src/`.

## Conventional Commits

We follow https://www.conventionalcommits.org/en/v1.0.0/ to keep history readable and enable consistent releases. The changelog is maintained manually.

- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`.
- Optional scope: e.g., `feat(logs): add status filter`.
- Breaking changes: use `!` after type/scope (`feat!: ...`) or add a `BREAKING CHANGE:` footer.

Examples:

```
feat(logs): add filter by status and code unit

fix(tail): handle CLI not found with actionable message

docs: improve README with Marketplace badges and usage
```

## Release Process (Tag‑driven; Manual Changelog)

- Merge PRs to `main` using Conventional Commits.
- Update `CHANGELOG.md` manually for the new version (follow SemVer; include notable changes and any BREAKING CHANGES).
- Bump `apps/vscode-extension/package.json` to the release version and push a tag `vX.Y.Z` pointing to that commit.
- The Release workflow (on tag push) builds, packages, and publishes automatically to the Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`) when configured.

Manual packaging (rare):

- Stable: `pnpm run vsce:package` then `pnpm run vsce:publish`.
- Pre‑release: `pnpm run vsce:package:pre` then `pnpm run vsce:publish:pre`.
- Open VSX (stable): `pnpm dlx ovsx publish --pat <token>`.
- Open VSX (pre‑release): `pnpm dlx ovsx publish --pat <token> --pre-release`.

## Pull Request Checklist

- [ ] Uses Conventional Commits in title and commits.
- [ ] `pnpm run build` passes locally.
- [ ] `pnpm test` passes locally.
- [ ] `CHANGELOG.md` updated when the change is user‑facing.
- [ ] Screenshots/GIFs for UI changes.
- [ ] Notes on verification steps and risk/rollback if needed.

## Security & Privacy

- Requires Salesforce CLI with an authenticated org (`sf org login web`).
- Never log or commit tokens or org-sensitive data.
- When `electivus.apexLogViewer.logging.trace` is enabled, review output before sharing externally.
 - Telemetry: respect the user's VS Code `telemetry.telemetryLevel`. Never include source code, Apex log content, access tokens, usernames, org IDs, or instance URLs in telemetry. Keep events minimal (counts/flags), prefer bounded enums over free-form strings, and consider sampling to avoid high-frequency spam.

## Sensitive Files Guardrails

- Forbidden in commits: `*.log` and `*.txt`.
- Local logs: keep under `apexlogs/` (already in `.gitignore`).
- CI: `.github/workflows/forbid-sensitive-files.yml` fails if any tracked `.log/.txt` exist in PRs.
- Packaging: controlado via `files` no `package.json` (somente `dist/**`, bundles em `media/*.js` e metadados são empacotados; logs e fontes não entram).

Unstage by mistake:

```
git restore --staged path/to/file.log
```

## Questions

- General usage: see `README.md`.
- Repo guidelines and architecture notes: see `AGENTS.md`.
