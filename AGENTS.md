# Repository Guidelines

## Project Structure & Module Organization

- `src/extension.ts`: VS Code activation and command registration.
- `src/provider/`: webview provider and extension↔webview messaging.
- `src/webview/`: React UI; bundled to `media/main.js`.
- `src/shared/`: shared types and message contracts.
- `src/utils/`: helpers (e.g., `localize.ts`, `limiter.ts`).
- `scripts/`: build helpers (e.g., `gen-nls.cjs`).
- `media/`: static assets and the webview bundle.
- `dist/`: compiled extension entry (`extension.js`).
- `out/`: compiled tests (`out/test/**/*.js`).
- Tooling: `esbuild.js`, `eslint.config.mjs`, `tsconfig.json`.

## Build, Test, and Development

- `npm run watch`: parallel watch for extension, types, and webview; launch with VS Code `F5`.
- `npm run build`: type-check, lint, and bundle extension + webview.
- `npm test`: compiles tests then runs VS Code tests.
- `npm run lint`: run ESLint over `src`.
- `npm run check-types`: TypeScript `--noEmit` check.
- `npm run vsce:package`: create a `.vsix` (requires `vsce`).

## Coding Style & Naming

- Use English for all code, comments, and documentation.
- TypeScript strict mode; 2-space indent; include semicolons.
- ESLint enforced: `curly`, `eqeqeq`, `no-throw-literal`; fix warnings before PRs.
- Names: PascalCase for React components/classes; camelCase for functions/vars.
- Files: components as `src/webview/components/Name.tsx`; utilities as `src/utils/name.ts`.

## Testing Guidelines

- Framework: `@vscode/test-cli` (Mocha typings).
- Location: `src/test/**/*.test.ts` compiled to `out/test/**/*.test.js`.
- Naming: `*.test.ts`; use `describe`/`it`.
- Run: `npm test` (runs build + lint via `pretest`).

## Commit & Pull Request Guidelines

- Commits: imperative, concise subject ≤72 chars (e.g., "Add head concurrency setting"); reference issues in body (e.g., `Closes #123`).
- PRs: clear description, linked issues, screenshots/GIFs for UI, verification steps, and risk/rollback notes.
- Ensure `npm run build` and `npm test` pass; update `CHANGELOG.md` for user‑visible changes (Keep a Changelog).

## Security & Configuration

- Requires Salesforce CLI (`sf` or legacy `sfdx`) with an authenticated org (e.g., `sf org login web`).
- Never log or commit tokens or org-sensitive data; review `src/salesforce.ts` for CLI/HTTP usage.
- Avoid large logs in the repo; share redacted samples externally.
- Localization: extension uses `vscode-nls`; packaging generates `dist/extension.nls.json` and `.pt-br.json`.
