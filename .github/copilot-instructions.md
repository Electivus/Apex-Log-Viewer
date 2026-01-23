# AI Coding Agent Instructions

Concise project knowledge so an AI can contribute productively. Keep answers specific to this repo (Electivus Apex Log Viewer – VS Code extension for Salesforce Apex logs).

## Core Architecture

- Two halves: Extension Host (`src/extension.ts`, providers under `src/provider/`) and Webview React UI (`src/webview/**/*.tsx` bundled by esbuild to `media/{main,tail,diagram}.js`). Shared message + data contracts live in `src/shared/` (e.g. `diagramMessages.ts`, `types.ts`).
- Data flow: command or UI action → extension executes Salesforce CLI (`sf` preferred, fallback `sfdx`) via helpers in `src/salesforce/{cli,traceflags,streaming}.ts` → parses/normalizes (see `src/shared/apexLogParser.ts`) → sends webview message → React reducer updates virtualized table (`react-window`). UI actions post messages back.
- Tail + Diagram views are separate webviews (`tail.tsx`, `diagram.tsx`). Activation event currently tied to `sfLogs.showDiagram`; other commands lazily register on activation.

## Key Conventions

- TypeScript everywhere; Node ≥20; max line width ~120; 2-space indents; semicolons enforced by ESLint/Prettier (`eslint.config.mjs`).
- Naming: PascalCase for React components/classes; camelCase for functions/vars; test files `*.test.ts` (`integration.*.test.ts` for integration scope).
- Shared code placed in `src/shared`; pure helpers in `src/utils`; provider-facing logic under `src/provider`.
- Settings: prefer new `electivus.apexLogs.*` keys; legacy `sfLogs.*` kept for backward compatibility—if adding a new setting, add only the new namespace unless intentionally providing a deprecated mirror.
- Conventional Commits required (commitlint + Husky). Use scoped type: `feat(logs): ...`, `fix(cli): ...`.
- Never commit `.log` / `.txt` outside `apexlogs/` (blocked by lint-staged + guard scripts). Do not log org IDs, tokens, or Apex log bodies.

## Build & Dev Workflow

- Install: `npm ci`.
- Active dev: run `npm run watch` (parallel: extension esbuild, tsc watch, webview bundler) then F5 (Extension Development Host).
- One-off build (CI/PR): `npm run build` (bundles extension + minified webviews). Prepublish packaging uses `npm run package` (adds NLS extraction/writing) before `vsce` packaging.
- Type checks only: `npm run check-types`; lint: `npm run lint`.
- Telemetry key is injected only during packaging via scripts (`telemetry:inject` / `telemetry:strip`). Never hardcode connection strings.

## Testing

- Unit vs integration selected by runner flags. Commands:
  - `npm test` (unit scope default)
  - `npm run test:integration`
  - `npm run test:all`
- Test harness: `scripts/run-tests.js` + `src/test/runner.ts`; compiled output under `out/test`. Temporary workspace + minimal `sfdx-project.json` auto-generated.
- Use Mocha TDD (`suite`/`test`). For new integration test touching VS Code APIs or requiring extension activation, name file `integration.<feature>.test.ts`.
- Avoid depending on a real org unless necessary; if needed, follow env vars in `docs/TESTING.md` (e.g. `SF_DEVHUB_AUTH_URL`).

## Feature Implementation Patterns

- Add new command: declare under `contributes.commands` in `package.json`, register in `activate()` (see `src/extension.ts`), return early on errors with user-facing `vscode.window.showErrorMessage` sparingly; prefer logging to extension output channel.
- Webview messaging: define a discriminated union message type in `src/shared/*Messages.ts`; update both sender (extension provider) and receiver (React) with exhaustive switch statements for safety.
- CLI interactions: centralize in `src/salesforce/cli.ts`. Prefer spawning `sf` first; gracefully degrade to `sfdx`. Add caching through existing CLI cache settings (`electivus.apexLogs.cliCache.*`). Handle timeouts via existing helper patterns.
- Parsing Apex logs: extend `apexLogParser.ts`; keep pure & side-effect free. Add unit tests for new parsing logic.
- Telemetry: emit only via wrapper in `src/shared/telemetry.ts`. Never pass raw error messages containing potential PII—map to coarse categories.

## Localization / NLS

- User-visible strings for extension (commands/settings) rely on `vscode-nls`. After adding strings that surface in compiled `dist/**/*.js`, run: `npm run nls:extract && npm run nls:write`. Provide translations in `package.nls.json` + `package.nls.pt-br.json` if needed.
- Webview UI currently bundles English + pt-BR assets; mirror additions there.

## CI & Release

- Workflows in `.github/workflows/*.yml`: `ci.yml` (build/test), `release.yml` (tag → publish), `prerelease.yml` (nightly). Odd minor = pre-release, even minor = stable.
- Release prep: bump `package.json`, update `CHANGELOG.md`, tag `vX.Y.Z`. CI handles packaging; telemetry key must be available as env var for production builds.

## When Editing / Submitting PRs

- Run: `npm run lint && npm run check-types && npm test` before push.
- Keep diffs minimal; avoid formatting unrelated code (Prettier will enforce style anyway).
- Update `docs/` if changing architecture, settings, telemetry, or release flow.

## Quick Examples

- Adding a message type: modify `src/shared/diagramMessages.ts` (or create new), export `{ type: 'newMessage', payload: {...} }`; extend switch in provider + React reducer.
- Adding a setting: edit `package.json#contributes.configuration.properties.electivus.apexLogs.<name>` (include `default`, `minimum` if numeric), reference via `vscode.workspace.getConfiguration('electivus.apexLogs')`.

## Guardrails

- Do NOT: introduce third-party network calls outside Salesforce CLI / VS Code APIs; store secrets; commit generated bundles outside allowed list; bypass telemetry wrapper.
- Prefer: pure functions for parsing, centralized error handling, incremental rendering in webview.

(End)
