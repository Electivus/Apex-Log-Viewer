# Contributing to Apex Log Viewer

Thanks for taking the time to contribute! This guide covers local setup, coding standards, Conventional Commits, and how releases are automated.

## Quick Start

- Requirements: Node.js 20+, VS Code 1.87+, Salesforce CLI (`sf` recommended or legacy `sfdx`).
- Clone and install: `npm install`
- Build once: `npm run build`
- Dev mode: `npm run watch` then press `F5` in VS Code to launch the Extension Development Host.
- Tests: `npm test` (runs type-check, lint, and VS Code tests).
- Lint/format: `npm run lint` and `npm run format`.

Helpful scripts:

- `npm run watch` – parallel watch for extension, types, and webview; use VS Code `F5`.
- `npm run build` – type-check, lint, bundle extension + webview.
- `npm test` – compiles tests and runs VS Code tests.

## Coding Style

- TypeScript strict mode; 2-space indent; include semicolons.
- ESLint enforced: `curly`, `eqeqeq`, `no-throw-literal`; fix warnings before PRs.
- Names: PascalCase for React components/classes; camelCase for functions/vars.
- Files: components as `src/webview/components/Name.tsx`; utilities as `src/utils/name.ts`.

## Conventional Commits

We follow https://www.conventionalcommits.org/en/v1.0.0/ so that releases and the changelog are generated automatically by Release Please.

- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`.
- Optional scope: e.g., `feat(logs): add status filter`.
- Breaking changes: use `!` after type/scope (`feat!: ...`) or add a `BREAKING CHANGE:` footer.

Examples:

```
feat(logs): add filter by status and code unit

fix(tail): handle CLI not found with actionable message

docs: improve README with Marketplace badges and usage
```

## Release Automation (Release Please)

- Do not edit `CHANGELOG.md` directly. Release Please manages it.
- Merge PRs to `main` using Conventional Commits.
- Release Please will open/update a release PR with version + changelog.
- When that PR is merged, a tag and GitHub Release are created.
- CI then builds, packages, and (when `VSCE_PAT` is configured) publishes to the Marketplace.

Manual packaging (rare):

- Stable: `npm run vsce:package` then `npm run vsce:publish`.
- Pre‑release: `npm run vsce:package:pre` then `npm run vsce:publish:pre`.

## Pull Request Checklist

- [ ] Uses Conventional Commits in title and commits.
- [ ] `npm run build` passes locally.
- [ ] `npm test` passes locally.
- [ ] No direct edits to `CHANGELOG.md`.
- [ ] Screenshots/GIFs for UI changes.
- [ ] Notes on verification steps and risk/rollback if needed.

## Security & Privacy

- Requires Salesforce CLI with an authenticated org (`sf org login web`).
- Never log or commit tokens or org-sensitive data.
- When `sfLogs.trace` is enabled, review output before sharing externally.

## Questions

- General usage: see `README.md`.
- Repo guidelines and architecture notes: see `AGENTS.md`.

