# Architecture

Apex Log Viewer is a pnpm monorepo with a VS Code extension and Salesforce CLI plugin over one private TypeScript core, plus an independent native Kotlin IntelliJ plugin kept behaviorally aligned through conformance scenarios.

```text
apps/
  vscode-extension/       VS Code host, adapters, tests, packaging, media
  intellij-plugin/        Native Kotlin runtime, IntelliJ UI, tests, packaging
packages/
  core/                   Salesforce and local-log business behavior
  protocol/               Extension/webview messages and UI-safe DTOs
  sf-plugin/              Salesforce CLI command adapters
  webview/                React webview applications
skills/                   Neutral Agent Skills catalog
test/e2e/                 Real-org extension and CLI tests
test/conformance/         Versioned language-neutral runtime scenarios and schemas
```

## Dependency boundaries

- `@alv/core` is private and has no VS Code or oclif dependency. Its long-lived `ApexLogLifecycle` owns local-first discovery, remote body acquisition, canonical and legacy materialization, shared concurrent acquisition, sync checkpoints, status, triage orchestration, and safe local purge. Apex log catalog and remote deletion remain separate core operations. The core also owns org resolution, users, trace flags, debug levels, Tooling API reads, cancellation, stable errors, and instrumentation hooks.
- `@alv/protocol` is private and has no VS Code runtime dependency. It is the source of truth for webview messages, validators, UI DTOs, column preferences, and shared formatting helpers.
- `apps/vscode-extension` imports the core directly. esbuild includes it in `dist/extension.js`; no plugin, command parser, runner, or child process is shipped in the VSIX.
- `packages/sf-plugin` contains class-per-command `SfCommand` adapters. It depends on the core through `workspace:*`, and the npm staging step materializes `@alv/core` as a bundled private dependency.
- `packages/webview` imports only `@alv/protocol` for its host contract.
- `skills/apex-log-viewer-cli` is the canonical Apex Log Viewer Agent Skill source. It depends on the public `sf electivus` contract at use time but is not bundled into, installed by, or lifecycle-coupled to the Salesforce CLI plugin.
- `apps/intellij-plugin` is a self-contained Java 21 Kotlin implementation. It does not execute the TypeScript core, use a Node sidecar, or depend on `sf electivus`; its public runtime facade conforms through the shared versioned corpus under `test/conformance/`.

The adapters under `apps/vscode-extension/src/shared/` only re-export protocol modules while extension-local telemetry and diagnostics remain in the app.

## Dual-runtime conformance

The TypeScript runner enters through `createApexLogViewerCore`; the Kotlin runner enters through `createApexLogViewerRuntime`. Both consume the same JSON schemas and scenarios directly, create a fresh real workspace per scenario, and inject controllable process and HTTP boundaries. Exact normalized results, classified failures, and final workspace files are the contract. Private helper calls, class decomposition, timestamps, temporary filenames, and incidental request ordering are not.

`pnpm run test:conformance` runs both facades without Salesforce credentials or an IDE UI. New shared behaviors extend the current corpus version when compatible; incompatible semantic changes start a new versioned directory.

## Extension host

The entry point is `apps/vscode-extension/src/extension.ts`. Extension-only Salesforce/UI adapters live under `apps/vscode-extension/src/host/`; providers and panels live beside them under `provider/` and `panel/`.

The client in `apps/vscode-extension/src/runtime/runtimeClient.ts` preserves the extension-facing method surface while calling `@alv/core` in process. It supplies the workspace root, deduplicates concurrent org/auth reads, translates core log DTOs to the existing webview shape, maps cancellation to `AbortError`, and emits `core.request` telemetry.

Extension Open, Replay, Tail body reads, full-log search preparation, triage, sync, status, and local purge all cross `ApexLogLifecycle`. The extension retains presentation, streaming subscriptions, Replay commands, ripgrep execution, and retention-policy selection; it does not construct cache paths or write Apex log bodies.

### Webview Session

Logs and Tail each bind one rebindable Webview Session. This is the extension's single production implementation of delayed mount, readiness, visibility, classified delivery, latest-snapshot replay, bounded retry, stale-generation rejection, temporary detach, final disposal, and payload-free mechanical diagnostics.

The host adapters expose capabilities instead of identities: a sidebar can prepare and remount its current host in place, while an editor can replace its panel. Webview Session does not branch on a panel/sidebar or editor/sidebar discriminator. Both adapters preserve the established `retainContextWhenHidden` behavior.

The Logs and Tail providers continue to own presentation HTML, authoritative replay snapshots, bootstrap and refresh policy, validated interactions, workflow errors, and surface diagnostics. They explicitly classify deliveries and supply the latest replay batch on request; Webview Session does not retain a generic journal or know either surface's snapshot schema.

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

Every route has its own `SfCommand` class and declarative flags. Destructive commands retain `--dry-run` and `--yes`. The plugin owns Salesforce and local-log operations only; Agent Skill distribution belongs to the external `skills` CLI.

## Agent Skill distribution

The top-level `skills/` catalog is vendor-neutral and follows the common Agent Skills format. Project-scoped installation through `npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli` is the primary route, with `skills-lock.json` as the consumer-side reproducibility contract. Agent selection, canonical-copy/link behavior, update, removal, and platform fallback all remain owned by the `skills` CLI.

The Agent Skill and `@electivus/plugin-electivus` release independently. Operational workflows therefore begin with `sf electivus doctor --json`, use `runtimeVersion` as an initial compatibility signal, and verify command availability before execution. Optional agent metadata may improve presentation but cannot alter core behavior.

## Local log storage

Both surfaces use the same org-first store:

- `apexlogs/.alv/version.json` — layout version.
- `apexlogs/.alv/sync-state.json` — incremental checkpoints by org.
- `apexlogs/orgs/<safe-org>/org.json` — resolved org metadata.
- `apexlogs/orgs/<safe-org>/logs/<YYYY-MM-DD>/<logId>.log` — canonical full log bodies.

Legacy `<safeUser>_<logId>.log` files remain readable for backward compatibility. New writes use the org-first layout; no third cache layout is introduced.
Before the first workspace write, the lifecycle best-effort adds `apexlogs/` to an existing regular `.gitignore`; it never follows a symbolic-link `.gitignore`.

The lifecycle receives an explicit absolute workspace root and treats the resolved Salesforce username as the canonical org identity. Alias metadata and prior sync-state shapes remain readable offline. Required consumers receive a dependable local path or a stable error; Tail alone opts into best-effort persistence so a freshly acquired body can still be displayed when disk persistence fails.

## Build and packaging

- `pnpm install --frozen-lockfile` installs all workspace packages from `pnpm-lock.yaml`.
- `pnpm run build:shared` builds the private core and protocol.
- `pnpm run build:extension` bundles the extension and core into one CommonJS extension artifact.
- `pnpm run build:webview` bundles the React applications.
- `pnpm run build:sf-plugin` builds class-per-command CLI output and its oclif manifest.
- VSIX packaging uses `--no-dependencies` because runtime code is bundled and the ripgrep native package is staged explicitly.
- Plugin npm staging copies `@alv/core` into `node_modules/@alv/core` and marks it as a bundled dependency.
- Plugin npm staging does not copy or declare Agent Skill artifacts.

## Data flow

1. A command or webview message reaches an extension provider.
2. The provider calls the in-process core client.
3. The lifecycle checks the shared store first, resolves Salesforce auth through its injected remote seam only when needed, and atomically materializes any acquired body.
4. The extension adapts the result to `@alv/protocol` and posts it to the webview.
5. The CLI surface calls the same core operation and returns the same camelCase JSON DTO.
