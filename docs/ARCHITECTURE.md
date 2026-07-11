# Architecture

Apex Log Viewer is a pnpm monorepo with two independent product surfaces over one private TypeScript core.

```text
apps/
  vscode-extension/       VS Code host, adapters, tests, packaging, media
packages/
  core/                   Salesforce and local-log business behavior
  protocol/               Extension/webview messages and UI-safe DTOs
  sf-plugin/              Salesforce CLI commands and Codex skill installer
  webview/                React webview applications
test/e2e/                 Real-org extension and CLI tests
```

## Dependency boundaries

- `@alv/core` is private and has no VS Code or oclif dependency. It owns org resolution, Apex log list/sync/read/resolve/triage/delete, users, trace flags, debug levels, Tooling API reads, cancellation, stable errors, and instrumentation hooks.
- `@alv/protocol` is private and has no VS Code runtime dependency. It is the source of truth for webview messages, validators, UI DTOs, column preferences, and shared formatting helpers.
- `apps/vscode-extension` imports the core directly. esbuild includes it in `dist/extension.js`; no plugin, command parser, runner, or child process is shipped in the VSIX.
- `packages/sf-plugin` contains class-per-command `SfCommand` adapters. It depends on the core through `workspace:*`, and the npm staging step materializes `@alv/core` as a bundled private dependency.
- `packages/webview` imports only `@alv/protocol` for its host contract.

The adapters under `apps/vscode-extension/src/shared/` only re-export protocol modules while extension-local telemetry and diagnostics remain in the app.

## Extension host

The entry point is `apps/vscode-extension/src/extension.ts`. Extension-only Salesforce/UI adapters live under `apps/vscode-extension/src/host/`; providers and panels live beside them under `provider/` and `panel/`.

The client in `apps/vscode-extension/src/runtime/runtimeClient.ts` preserves the extension-facing method surface while calling `@alv/core` in process. It supplies the workspace root, deduplicates concurrent org/auth reads, translates core log DTOs to the existing webview shape, maps cancellation to `AbortError`, and emits `core.request` telemetry.

Commands, view ids, and settings use the `electivus.apexLogViewer.*` namespace. Old `sfLogs.*` and `electivus.apexLogs.*` aliases are intentionally not registered.

## Salesforce CLI plugin

The public plugin exposes singular command topics such as:

```text
sf electivus org list
sf electivus log sync --target-org my-org
sf electivus trace-flag status --current-user --target-org my-org
sf electivus debug-level list --target-org my-org
sf electivus tooling query --soql "SELECT Id FROM ApexLog" --target-org my-org
```

Every route has its own `SfCommand` class and declarative flags. Destructive commands retain `--dry-run` and `--yes`. Plugin-only behavior, including `sf electivus skill install`, stays outside the shared core.

## Local log storage

Both surfaces use the same org-first store:

- `apexlogs/.alv/version.json` — layout version.
- `apexlogs/.alv/sync-state.json` — incremental checkpoints by org.
- `apexlogs/orgs/<safe-org>/org.json` — resolved org metadata.
- `apexlogs/orgs/<safe-org>/logs/<YYYY-MM-DD>/<logId>.log` — canonical full log bodies.

Legacy `<safeUser>_<logId>.log` files remain readable for backward compatibility. New writes use the org-first layout; no third cache layout is introduced.

## Build and packaging

- `pnpm install --frozen-lockfile` installs all workspace packages from `pnpm-lock.yaml`.
- `pnpm run build:shared` builds the private core and protocol.
- `pnpm run build:extension` bundles the extension and core into one CommonJS extension artifact.
- `pnpm run build:webview` bundles the React applications.
- `pnpm run build:sf-plugin` builds class-per-command CLI output and its oclif manifest.
- VSIX packaging uses `--no-dependencies` because runtime code is bundled and the ripgrep native package is staged explicitly.
- Plugin npm staging copies `@alv/core` into `node_modules/@alv/core` and marks it as a bundled dependency.

## Data flow

1. A command or webview message reaches an extension provider.
2. The provider calls the in-process core client.
3. The core resolves Salesforce auth through `@salesforce/core`, performs the operation, and reads or writes the shared store.
4. The extension adapts the result to `@alv/protocol` and posts it to the webview.
5. The CLI surface calls the same core operation and returns the same camelCase JSON DTO.
