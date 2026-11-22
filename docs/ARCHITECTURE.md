# Architecture

Apex Log Viewer is a pnpm monorepo with a VS Code extension and Salesforce CLI plugin over one private TypeScript core.

```text
apps/
  vscode-extension/       VS Code host, adapters, tests, packaging, media
packages/
  core/                   Salesforce and local-log business behavior
  protocol/               Extension/webview messages and UI-safe DTOs
  sf-plugin/              Salesforce CLI command adapters
  webview/                React webview applications
skills/                   Neutral Agent Skills catalog
plugins/electivus-debug/   Generated self-contained agent plugin
test/e2e/                 Real-org extension and CLI tests
test/conformance/         Versioned core behavioral scenarios and schemas
```

## Dependency boundaries

- `@alv/core` is private and has no VS Code or oclif dependency. Its long-lived `ApexLogLifecycle` owns local-first discovery, remote body acquisition, canonical and legacy materialization, shared concurrent acquisition, sync checkpoints, status, triage orchestration, and safe local purge. Apex log catalog and remote deletion remain separate core operations. The core also owns org resolution, users, trace flags, debug levels, Tooling API reads, cancellation, stable errors, and instrumentation hooks.
- `@alv/protocol` is private and has no VS Code runtime dependency. It is the source of truth for webview messages, validators, UI DTOs, column preferences, and shared formatting helpers.
- `apps/vscode-extension` imports the core directly. esbuild includes it in `dist/extension.js`; no plugin, command parser, runner, or child process is shipped in the VSIX.
- `packages/sf-plugin` contains class-per-command `SfCommand` adapters. It depends on the core through `workspace:*`, and the npm staging step materializes `@alv/core` as a bundled private dependency.
- `packages/webview` imports only `@alv/protocol` for its host contract.
- `skills/` is the canonical catalog for `apex-log-viewer-cli`, `apex-debug-investigate`, and `apex-debug-performance`. It depends on the public `sf electivus` contract at use time and is copied into the npm plugin for explicit offline installation and into the generated agent plugin.

The adapters under `apps/vscode-extension/src/shared/` only re-export protocol modules while extension-local telemetry and diagnostics remain in the app.

## Core behavioral contract

The TypeScript runner enters through `createApexLogViewerCore` and consumes the versioned JSON schemas and scenarios under `test/conformance/`. It creates a fresh real workspace per scenario and injects controllable process and HTTP boundaries. Exact normalized results, classified failures, and final workspace files are the contract. Private helper calls, class decomposition, timestamps, temporary filenames, and incidental request ordering are not.

`pnpm run test:conformance` runs this contract without Salesforce credentials or an IDE UI; the same scenarios are included in `test:core`. Compatible scenarios extend the current corpus version; incompatible semantic changes start a new versioned directory.

## Extension host

The entry point is `apps/vscode-extension/src/extension.ts`. Extension-only Salesforce/UI adapters live under `apps/vscode-extension/src/host/`; providers and panels live beside them under `provider/` and `panel/`.

The client in `apps/vscode-extension/src/runtime/runtimeClient.ts` preserves the extension-facing method surface while calling `@alv/core` in process. It supplies the workspace root and the `sf` CLI auth source, deduplicates concurrent org list reads, translates core log DTOs to the existing webview shape, maps cancellation to `AbortError`, and emits `core.request` telemetry.

### Salesforce auth

The extension never reads, refreshes or writes Salesforce auth files; the `sf` CLI does, and so does the plugin, which runs inside `sf`. Core takes an `OrgAuthSource` (`packages/core/src/orgSessions.ts`) and keeps each org's access token in memory, in one session per username that every caller shares. It asks the source at the first use of an org, and again only after Salesforce rejects the token, then retries the request once. A renewed token that Salesforce rejects again ends with `AUTH_REQUIRED`.

The extension's source (`apps/vscode-extension/src/host/salesforce/sfCliAuth.ts`) runs `sf org list auth`, then `sf org auth show-access-token`, or `sf org display` on a CLI that lacks that command (before 2.136.6), so the first token lookup there runs two commands. What a failing `sf` prints reaches errors and the trace through `exec.ts`, which first removes terminal control sequences from the failed command's stdout, stderr and message (raw, and JSON-escaped as `\u001b[...m`), then holds every string under a secret-named key that the output parses to, and only then builds the Error, its streams and the trace line with `redactSecrets` (`apps/vscode-extension/src/host/utils/redact.ts`). The auth source holds every token a successful `sf` prints the same way, after a renewal too. A value shorter than 12 UTF-16 code units, or with a space inside, is not held, because it could be an ordinary word. The held tokens live in a `Set` of `redact.ts` for the life of the extension host process: `deactivate()` does not clear it, and they are released when the process exits. `redactSecrets` replaces values under secret-named keys; each held token where the text has it as written, or where a reader that starts at any place of the text, takes the rest of a percent-encoding it starts in as written and decodes the percent-encoded UTF-8 after it, reads it; and text shaped like a session id (`00D` org id, `!`, session), a JWT or a refresh token (`5Aep8`), or an SFDX auth URL (`force://` to the `@`). A session id runs to the first space, quote, comma, semicolon or bracket. On top of what those rules replace, a JWT or refresh token, and an unclosed `Bearer` value in which one of the three shapes starts, are replaced to the first character that no credential holds: the characters of an RFC 6750 `b64token` (letters, digits, `-._~+/` and `=` padding), the `!` of a session id and `%`. `%` and `/` are not checked further, so an error code glued after them goes with the value. `|`, `\`, `&`, `@`, `:` and `#` end this run, so after a JWT or refresh token that no other rule covers, the error code or parameter after them stays. A JWT may have `=` padding before its dots. This step reads only the text and the held secrets and only adds to what the other rules replace, so it cannot keep any of them from matching. The logger applies `redactSecrets` to every line. Only well-formed UTF-8 is decoded: a `%` without two hex digits, or bytes that are truncated, overlong, an encoded surrogate or past U+10FFFF, are not decoded and stay as written, where they match only a held token that has the same characters. It cannot recognize three cases: a credential split across lines, held or not; a credential the extension does not hold that is re-encoded; and a held token with a `%` written as is that the characters after it make a well-formed percent-encoding, such as a token with `%41` in it or one that ends in `%` followed in the text by `41`, while other characters of the token are encoded. A token written all as is, or with each of its `%` encoded as `%25`, is found. Held tokens are compared with the text in UTF-16 code units, so a token that ends in the first half of a surrogate pair is found where the text has that half. One Aho-Corasick automaton over the held tokens, each written backwards, finds the longest held token that starts at each place in one pass over the text as written and one over the text decoded. A reader that starts inside a percent-encoding feeds the characters left in it from the state the decoded pass reached after it; for those characters the automaton finds the deepest node on the failure links with an edge on that character by a binary search over the failure-link tree, indexed on the first text with a `%` after the held tokens change, instead of walking the links. The search keeps nothing from one text to the next, and takes a number of steps in proportion to the text, times the logarithm of the number of held tokens' characters for each character of a percent-encoding. The rules for secret-named values and token shapes run on the text as written, and again with the held tokens replaced, so a held token that covers part of a name such as `accessToken` does not keep the value after the name from being replaced. The first redaction after a new token is held builds the automaton again, in time proportional to the total length of the held tokens. The union of the places is replaced at once, so a held token that begins or overlaps another leaves no part of either. When a call ends with `AUTH_REQUIRED`, the core client reads `sf --version`, and below 2.157.8 adds to the message how to update. Because only `sf` refreshes, an org whose connected app rotates refresh tokens needs a CLI that keeps the new token: 2.157.8 or newer, which bundles `@salesforce/core` 9.4.1 or later, the first release with the clock fix (a `@salesforce/core` before 9.4.1 can drop the new tokens when its auth-change stamp trails the auth file's clock). The plugin's source (`packages/sf-plugin/src/sfCoreAuth.ts`) runs inside `sf` with the plugin's own copy of `@salesforce/core`, a dependency of the plugin package, not the instance the CLI loads. It reads auth in-process, and after a rejected session it refreshes the token and saves it with `AuthInfo.save`, as any `sf` command does. ESLint rejects `@salesforce/core` imports in the core and extension sources.

Extension Open, Replay, Tail body reads, full-log search preparation, triage, sync, status, and local purge all cross `ApexLogLifecycle`. The extension retains presentation, Tail's streaming subscription, Replay commands, ripgrep execution, and Apex log retention-policy selection; it does not construct cache paths, write Apex log bodies, or open event files. Custom Logs event capture (the subscription, the checkpoint, and the store) is the core operation `customLog.capture`, which the extension and the CLI both call.

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

Every route has its own `SfCommand` class and declarative flags. Destructive commands retain `--dry-run` and `--yes`. The plugin also owns `sf electivus skill install`, a local-only adapter that copies its bundled Agent Skills without accessing Salesforce or the network. Repeatable `--skill` and `--all` select the catalog; no selection preserves the original skill and response shape.

## Agent Skill distribution

The top-level `skills/` catalog is vendor-neutral and follows the common Agent Skills format. Project-scoped installation through `npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli` is the primary route, with `skills-lock.json` as the consumer-side reproducibility contract. For repository installations, agent selection, canonical-copy/link behavior, update, removal, and platform fallback remain owned by the `skills` CLI. The alternative npm channel ships the same canonical catalog and installs physical copies through `sf electivus skill install`, with project scope by default, explicit global/custom destinations, interactive selection, and force-gated replacement. It does not modify `skills-lock.json`.

Repository-based Agent Skills and `@electivus/plugin-electivus` can update independently; bundled skill snapshots follow the plugin release and require explicit reinstallation to update an agent copy. Org-backed workflows begin with `sf electivus doctor --json`, use `runtimeVersion` as an initial compatibility signal, and verify command availability before execution. Offline workflows begin with supplied files. Optional agent metadata may improve presentation but cannot alter core behavior.

`config/agent-plugin.json` declares the independent `electivus-debug` version and pinned official Certinia MCP command. `build:agent-plugin` derives `plugins/electivus-debug` and the Codex/Claude-compatible marketplace catalogs from this configuration and the same skill sources. The bundle includes portable Agent Plugins 1.0 manifests and client overlays. `check:agent-plugin` rejects drift, including stale files. It carries MCP configuration and license notices, not a vendored analyzer runtime. The MCP runs in the client's local filesystem with anonymous Apex execution disabled; skills also support plain local file analysis.

Investigation starts with bulk sync, then content search across the local corpus. Core sync results expose absolute roots and bounded failure details; status exposes the previous failed count without auth. There is no additional search index or remote filtering surface for Apex logs. The platform events that Custom Logs captures are the one capture store: `apexlogs/orgs/<safe-org>/events/`, owned by core. A single `capture.lease` per event object picks the one process that subscribes.

## Local log storage

Both surfaces use the same org-first store:

- `apexlogs/.alv/version.json` — layout version.
- `apexlogs/.alv/sync-state.json` — incremental checkpoints by org.
- `apexlogs/orgs/<safe-org>/org.json` — resolved org metadata.
- `apexlogs/orgs/<safe-org>/logs/<YYYY-MM-DD>/<logId>.log` — canonical full log bodies.

Legacy `<safeUser>_<logId>.log` files remain readable for backward compatibility. New writes use the org-first layout; no third Apex log layout is introduced. The event store is a separate, versioned sibling of `logs/`, and no Apex log walker reads it.
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
- The plugin build refreshes its generated `skills/` copy from the canonical catalog; npm staging includes that declared artifact and the packaged README. The tarball test installs from an extracted package with network/subprocess calls denied.

## Data flow

1. A command or webview message reaches an extension provider.
2. The provider calls the in-process core client.
3. The lifecycle checks the shared store first, resolves Salesforce auth through its injected remote seam only when needed, and atomically materializes any acquired body.
4. The extension adapts the result to `@alv/protocol` and posts it to the webview.
5. The CLI surface calls the same core operation and returns the same camelCase JSON DTO.
