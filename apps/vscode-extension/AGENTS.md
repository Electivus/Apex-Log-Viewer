# VS Code Extension Guidelines

## Scope
- This file applies to `apps/vscode-extension/` and its child directories.

## Project Structure and Architecture
- Extension host logic lives in `src/extension.ts`.
- Services live under `src/services/` and shared types under `src/shared/`.
- Webview source lives in `src/webview/` and bundles into `media/`.
- Webview and extension host communicate through VS Code webview messaging.

## Build, Test, and Development Commands
- `npm run ext:install` installs extension dependencies.
- `npm run ext:build` bundles the extension and webview.
- `npm run ext:watch` runs watchers; press `F5` in VS Code to launch the Extension Development Host.
- `npm run ext:test` runs lint, typecheck, Jest webview tests, and VS Code unit tests.
- Use `npm run lint` and `npm run format` to validate style.

## Coding Style and Naming Conventions
- TypeScript strict mode, 2-space indent, semicolons.
- Components/classes use `PascalCase`; functions/variables use `camelCase`.
- Component files follow `src/webview/components/Name.tsx`.
- Utility files follow `src/utils/name.ts`.

## Testing Guidelines
- Webview tests use Jest in `src/webview/__tests__/` with `*.test.tsx`.
- Extension tests run in the VS Code host under `src/test/`.
- Coverage thresholds are enforced via `c8` (see `.c8rc.json`).

## UX Direction
- Prioritize the best user experience over strict adherence to native VS Code UI components.
- Use Webview-based custom interfaces when they provide clearer workflows and lower friction than default VS Code controls.
- This project intentionally invests in Webviews because Salesforce's official extensions rely mostly on standard VS Code components, which has proven harder to use in practice.
