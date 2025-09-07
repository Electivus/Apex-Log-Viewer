# Repository Guidelines

## Project Structure & Module Organization
- `src/extension.ts` – VS Code extension entry. Core logic in `src/{provider,salesforce,utils,shared}`.
- `src/webview` – React/TSX UI for Panels (bundled to `media/*.js`). Components under `src/webview/components`.
- `src/test` – Mocha tests (unit/integration). Name tests `*.test.ts` or `*.test.tsx`. Runner and setup in `src/test/{runner,mocha.setup}.ts`.
- `dist/` – bundled extension (`main` points to `dist/extension.js`).
- `media/` – webview bundles and assets; `scripts/` – build/test utilities; `apexlogs/` – local logs (git‑ignored).

## Build, Test, and Development Commands
- Install: `npm ci`
- Develop: `npm run watch` then press `F5` in VS Code (Extension Development Host).
- Build: `npm run build` (lint + type‑check + bundle extension/webview).
- Lint/Format: `npm run lint` • `npm run format` • types: `npm run check-types`.
- Tests: `npm test` (unit by default). Scopes: `npm run test:unit`, `npm run test:integration`, or `npm run test:all`.
- Package VSIX: `npm run package` (build + NLS) then `npm run vsce:package` (or `:pre`).

## Coding Style & Naming Conventions
- Language: TypeScript (Node 20+). Indent 2 spaces; semicolons; LF line endings; 120‑char width.
- Prettier and ESLint are enforced. Fix warnings before PRs. Example: `eslint src`.
- Naming: PascalCase for React components/classes; camelCase for variables/functions.
- Files: utilities `src/utils/name.ts`; components `src/webview/components/Name.tsx`.

## Testing Guidelines
- Frameworks: Mocha + @vscode/test-electron; webview tests use JSDOM + @testing-library/react.
- Place tests under `src/test/`; prefer unit tests near related modules; mark integration tests with `integration.*.test.ts`.
- Integration tests may require the Salesforce CLI (`sf`) and an authenticated org; keep tests hermetic when possible.

## Commit & Pull Request Guidelines
- Conventional Commits are required (commitlint + Husky). Example: `feat(logs): add status filter`.
- PRs must: explain the change, link issues, include screenshots for UI changes, and pass `npm run build` and `npm test`.
- Do not commit sensitive files. `.log` and `.txt` are blocked by hooks and CI; keep local logs only in `apexlogs/`.

## Security & Configuration Tips
- Requires Salesforce CLI: `sf org login web` to authenticate. Never log or commit tokens, org IDs, or Apex log contents.
- Optional settings under `electivus.apexLogs.*` (pageSize, headConcurrency, tailBufferSize) can be adjusted in VS Code settings.
