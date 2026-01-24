# Repository Guidelines

## Project Structure & Module Organization

- Source lives in `src/`; `src/extension.ts` bootstraps the VS Code extension, with helpers under `src/utils` and `src/salesforce`, and webview UI in `src/webview`.
- Tests are colocated in `src/test` with focused suites (unit, integration, CLI).
- Bundled output lands in `dist/` (extension) and `media/` (webview). Regenerate these files; do not edit them manually.
- Local Apex log captures belong in `apexlogs/` (gitignored). Supporting docs and prototypes live in `docs/` and `Visual Prototype for Apex Log/`. Automation scripts sit in `scripts/`.

## Build, Test, and Development Commands

- `npm install` – install pinned dependencies (Node 22+).
- `npm run watch` – incremental build for extension, tests, and webview; launch via VS Code `F5` for live debugging.
- `npm run build` – run `build:extension` and `build:webview` for a release bundle.
- `npm run lint` / `npm run format` – enforce ESLint (`eslint.config.mjs`) and Prettier across sources.
- `npm run test` – compile and execute the default Mocha suite; use `npm run test:unit`, `npm run test:integration`, or `npm run test:all` for targeted scopes.

## Dependency Management

- Dependabot groups live in `.github/dependabot.yml`; when adding or upgrading dependencies, confirm the new package is matched by an existing group pattern.
- If the dependency belongs to a new technology area, create a dedicated group (or expand an existing one) so related packages are updated together.
- Ensure each dependency maps to exactly one group; avoid overlapping patterns when adding catch-all buckets.

## Coding Style & Naming Conventions

- TypeScript strict mode, 2-space indent, semicolons, and single quotes. Prettier is the source of truth for formatting.
- Keep ESLint clean; avoid disabling rules without justification in-code.
- PascalCase React components in `src/webview/components`; camelCase functions/constants elsewhere; kebab-case directory names.
- Husky + lint-staged block `.log`/`.txt` files—keep transient logs inside `apexlogs/`.

## Testing Guidelines

- Tests live in `src/test/*.test.ts`, powered by Mocha, `@vscode/test-electron`, and React Testing Library.
- Name suites after the unit under test (e.g., `tailService.test.ts`).
- `npm run pretest` performs clean, type-check, and build steps—run it before adding new suites.
- Integration runs require Salesforce CLI (`sf`) and may download VS Code builds; expect longer runtimes.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`type(scope): summary`); keep PR titles aligned. Include `!` or a `BREAKING CHANGE` footer when relevant.
- Before requesting review, ensure `npm run build` and `npm run test` pass locally and document any skipped suites.
- Update `CHANGELOG.md` for user-visible changes and attach screenshots/GIFs for UI tweaks. Call out telemetry impacts explicitly.

## Security & Configuration Tips

- Never commit org credentials or raw Apex logs; sanitize and store temporary files under `apexlogs/`.
- Respect VS Code telemetry settings and minimize payload content. When enabling trace logging (`electivus.apexLogs.trace`), scrub outputs before sharing.
