# Repository Guidelines

## Project Structure & Module Organization

- `src/extension.ts`: VS Code activation and command registration.
- `src/provider/`: webview providers and extension↔webview messaging.
- `src/webview/`: React UI; bundled to `media/main.js`.
- `src/shared/`: shared types and message contracts.
- `src/utils/`: helpers (e.g., `localize.ts`, `limiter.ts`).
- `scripts/`: build helpers (e.g., `gen-nls.cjs`).
- `media/`: static assets and the webview bundle.
- `dist/`: compiled extension entry (`extension.js`) and NLS output.
- `out/`: compiled tests (`out/test/**/*.js`).
- Tooling: `tsconfig.extension.json`, `eslint.config.mjs`, `tsconfig.json`.

## Build, Test, and Development Commands

- `npm run watch`: parallel watch for extension, types, and webview; launch with VS Code `F5` for debug.
- `npm run build`: compile the extension and bundle the webview.
- `npm test` / `npm run test:unit`: compile tests and run fast unit tests.
- `npm run test:integration`: run only integration tests; auto-installs `salesforce.salesforcedx-vscode`; fails if none run.
- `npm run test:all`: run unit + integration suites; fails if none run.
- `npm run lint`: run ESLint over `src`.
- `npm run check-types`: strict TypeScript `--noEmit` check.
- `npm run vsce:package`: create `.vsix` (requires `vsce`).

## Coding Style & Naming Conventions

- TypeScript strict mode; 2-space indent; include semicolons; English everywhere.
- ESLint rules enforced: `curly`, `eqeqeq`, `no-throw-literal`; fix warnings before PRs.
- Naming: PascalCase for React components/classes; camelCase for functions/vars.
- Files: components `src/webview/components/Name.tsx`; utilities `src/utils/name.ts`.

## Testing Guidelines

- Framework: `@vscode/test-electron` (Mocha typings).
- Location: `src/test/**/*.test.ts` → compiled to `out/test/**/*.test.js`.
- Naming: `*.test.ts`; use `describe`/`it`.
- Integration tests: titles start with `integration` and require the Salesforce extension and an authenticated org.
- CI safety: `VSCODE_TEST_FAIL_IF_NO_TESTS=1` prevents false greens.

## Commit & Pull Request Guidelines

- Commits: imperative, concise subject ≤72 chars (e.g., "Add head concurrency setting"); reference issues in body (e.g., `Closes #123`).
- PRs: clear description, linked issues, UI screenshots/GIFs, verification steps, and risk/rollback notes.
- Gates: `npm run build` and `npm test` must pass. Update `CHANGELOG.md` manually for user‑facing changes (follow SemVer; keep entries concise).

## Branching & Workflow (Agents)

- Never commit directly to `main`.
- Always start work on a new branch named by scope:
  - Feature: `feat/<short-topic>` (e.g., `feat/timeline-profiling-validator`)
  - Fix: `fix/<short-topic>` (e.g., `fix/diagram-empty-on-missing-prefix`)
  - Chore/Docs/Build: `chore/<topic>`, `docs/<topic>`, `build/<topic>`
- After implementing and validating locally:
  1. `git push -u origin <branch>`
  2. Open a Pull Request targeting `main`.
  3. Ensure CI passes (`npm run build`, tests) before merge.
- If a commit is accidentally pushed to `main`, immediately revert on `main`, push the revert, and reapply the changes on a feature branch via cherry-pick or revert-of-revert, then open a PR.

## Security & Configuration Tips

- Requires Salesforce CLI (`sf` or `sfdx`) with an authenticated org (e.g., `sf org login web`).
- Never commit or log tokens/org data; review `src/salesforce.ts` for CLI/HTTP usage.
- Localization via `vscode-nls`; packaging emits `dist/extension.nls.json` and `.pt-br.json`.
