# IntelliJ Plugin design

Status: accepted

## Outcome

Add an Apex Log Viewer plugin for IntelliJ IDEA with the user-facing capabilities of the VS Code extension except Tail. The plugin is a first-class JetBrains surface with native UI and a Kotlin runtime, not a wrapper around the VS Code extension or the separately released `sf electivus` plugin.

The architectural rationale and runtime boundary are recorded in [ADR 0003](adr/0003-use-a-conformant-kotlin-runtime-for-intellij.md).

## Product scope

- IntelliJ IDEA Community and Ultimate 2026.1–2026.2.
- Compile against the IntelliJ IDEA 2026.1 and Java 21 baseline.
- Verify both supported IDE lines and smoke-test the locally installed IntelliJ IDEA Ultimate 2026.2.
- Other JetBrains IDEs are outside the first-release compatibility claim.

## Surfaces

- One lazily initialized project tool window with separate Logs and Debug Flags tabs.
- A dedicated native editor for the parsed Apex Log Viewer.
- Open Raw Log opens the dependable local `.log` file in the standard text editor.
- Replay debugging is a **Replay Handoff**: the user starts the offline debugger through Illuminated Cloud 2, when installed. Apex Log Viewer does not implement or own Replay.

## Apex log recognition

The standard text editor remains the default editor for `.log` files. A log known to the Apex Log Lifecycle, or a local `.log` whose first ten logical lines within a bounded 64 KiB read contain the Salesforce markers `APEX_CODE,` or `|EXECUTION_STARTED|`, is eligible for an explicit **Open in Apex Log Viewer** action and alternate editor. This content check never scans the full file merely to decide editor eligibility.

Selecting a row from the Logs surface opens the dedicated parsed viewer directly because the lifecycle already establishes the file identity. Open Raw Log always returns to the standard text editor. Unrecognized `.log` files are never claimed by the plugin.

## Activation and project behavior

The project tool window is available in every IntelliJ IDEA project and initializes only when the user opens it or invokes an Apex Log Viewer action. Opening a project alone does not invoke the Salesforce CLI, call Salesforce, or create `apexlogs/`.

A missing `sfdx-project.json` does not block org selection, log acquisition and cleanup, local search, parsed or raw log viewing, or Debug Flags. In that mode the IntelliJ project root remains the lifecycle workspace root and owns `apexlogs/`; capabilities that genuinely require Salesforce project metadata are omitted or shown as unavailable with an explanation. When present, valid Salesforce project metadata may supply project-specific defaults such as `sourceApiVersion`.

## Functional scope

The IntelliJ Logs surface includes CLI-default-aware org selection, refresh and background incremental acquisition, pagination/infinite scroll, bulk download, configurable columns, error and triage indicators, parsed-log opening, raw-log opening, and Debug Flags navigation. Its search combines visible log metadata with lifecycle-approved local log bodies, presents body match snippets and pending-materialization status, and composes with user, operation, status, and Errors-only filters plus sorting.

Remote cleanup preserves both existing scopes: delete logs owned by the authenticated user or delete all Apex logs in the selected org. Both are irreversible Salesforce operations and require explicit modal confirmation, cancelable progress, and a summary that distinguishes deletion, failure, and cancellation counts.

The parsed viewer includes the existing debug-, SOQL-, DML-, and error-oriented views, in-view search, triage diagnostics, raw-file navigation, and text copying.

The Debug Flags surface includes user search by name or username; ordinary users plus the aggregated Automated Process and Platform Integration targets; `USER_DEBUG` coverage, debug level, mixed-state, and expiration display; TraceFlag application/removal with a custom TTL; the existing DebugLevel presets and all supported level fields; and DebugLevel creation, update, and deletion. Remote log cleanup is reachable from both Logs and Debug Flags, including the current remediation path for Salesforce log-storage-limit failures.

Tail views, streaming subscriptions, Tail settings, and Tail commands are not part of the IntelliJ plugin.

## Runtime and authentication

The IntelliJ-only Kotlin runtime implements Salesforce Tooling REST and the Apex Log Lifecycle while conforming to language-neutral fixtures shared with the TypeScript runtime. VS Code and `sf electivus` continue using `@alv/core`.

The Salesforce CLI is the authentication broker through `sf org list --json` and `sf org display --json`. Access tokens remain memory-only and redacted from logs and diagnostics. The Kotlin runtime performs Tooling REST calls itself and may refresh credentials once after an authentication failure.

Missing CLI installation, no authenticated orgs, malformed CLI JSON, expired credentials, network failures, unsupported Salesforce responses, partial downloads, and cancellations are modeled as classified, actionable states rather than unhandled exceptions. The UI preserves the last authoritative snapshot when a recoverable refresh fails and offers an explicit retry or setup action where applicable.

## Repository and execution boundary

The plugin lives in `apps/intellij-plugin/` as a self-contained Kotlin/Gradle IntelliJ Platform project with a checked-in Gradle wrapper. Language-neutral JSON schemas and fixtures live under `test/conformance/` and are consumed directly by both the Gradle and pnpm test lanes; generated Kotlin or TypeScript code is not the source of truth for the other runtime.

A project-scoped IntelliJ service owns the runtime, lifecycle workspace, selected org, cancellable operations, and disposal. Salesforce CLI processes, HTTP calls, filesystem work, parsing, triage, and full-log scanning run outside the Event Dispatch Thread under lifecycle-bound coroutine scopes; UI state is published back on the EDT. Closing a project or cancelling an IntelliJ progress task cancels its child work and prevents stale completion from mutating a newer project snapshot.

## Storage invariants

The IntelliJ surface uses the existing org-first `apexlogs/` store, sync-state contract, atomic materialization rules, and legacy-file compatibility. It does not introduce another cache layout. Shared conformance fixtures cover path safety, canonical identity, local-first behavior, checkpoint advancement, cancellation, partial failures, and triage outputs.

## Local full-log search

Local full-log search uses a Kotlin streaming scanner over only the explicit local paths approved by the Apex Log Lifecycle. It does not depend on IntelliJ project indexing and does not discover arbitrary `.log` files from the project.

The scanner preserves the current fixed-string, case-insensitive behavior. For each matching file it returns the first matching line, a display snippet, and submatch ranges. Work runs with bounded concurrency, supports prompt cancellation, reports lifecycle entries whose local materialization is still pending, and uses a small in-memory cache keyed by path, size, and modification time. The plugin does not package a native ripgrep binary.

## Configuration

Configuration parity between VS Code and IntelliJ is semantic rather than structural. A language-neutral contract keeps the meaning, defaults, and validation limits of shared runtime preferences aligned, initially including log page size, processing concurrency, and trace logging. Tail-only configuration is absent from IntelliJ.

The IntelliJ plugin exposes and persists these preferences through native JetBrains settings and state components. It does not read VS Code settings, reproduce VS Code key names as a storage format, or introduce a shared cross-IDE configuration file. Surface-owned presentation state such as column order, visibility, and widths follows IntelliJ conventions and is not a conformance requirement, although its initial defaults should remain behaviorally familiar.

Persistence uses a hybrid scope. Log page size, processing concurrency, trace logging, and presentation preferences are application-level user preferences. The selected org and restorable operational view state are project-level so concurrent projects cannot silently inherit one another's Salesforce target. Access tokens and other credentials are excluded from all persisted settings and state.

## Telemetry

Production builds use a plugin-owned opt-out for remote telemetry because IntelliJ IDEA's JetBrains data-sharing control does not govern collection implemented independently by third-party plugins. The first run clearly discloses the collection and points to an application-level Apex Log Viewer setting that disables it. Development and test builds do not send production telemetry unless a dedicated test configuration enables it.

The IntelliJ sender conforms to the repository's public, language-neutral telemetry catalog. Undeclared events and fields are dropped; errors use coarse classified codes rather than raw messages. Telemetry never includes source or Apex log content, search terms, usernames, org identifiers, instance URLs, local paths, access tokens, or other credentials. Surface identity is explicit so IntelliJ and VS Code behavior can be compared without conflating their populations.

## Diagnostics

The plugin keeps a bounded local buffer of structured operational diagnostics and exposes a command that opens a sanitized package in a preview. The user must explicitly choose to copy the package to the clipboard or save it to a selected file; the plugin never uploads diagnostics automatically.

The package may include plugin, IDE, OS, Java, and Salesforce CLI versions; coarse project capabilities; operation phases and classified outcomes; and bounded lifecycle state useful for support. It excludes source and Apex log content, search terms, usernames, aliases, org identifiers, instance URLs, access tokens, local paths, and raw trace output. The same allowlist and redaction rules apply both to the preview and the exported representation.

## Localization

Version 1.0.0 ships complete English and Brazilian Portuguese resource bundles, matching the languages already maintained by the VS Code extension. English is the fallback locale. All user-visible actions, settings, notifications, dialogs, tooltips, empty states, errors, and Marketplace-facing plugin text use resource keys; validation rejects missing locale keys and unintended hardcoded UI strings.

## Distribution outcome

This implementation ends with a Marketplace-ready plugin but does not upload or submit it to JetBrains Marketplace. The deliverable includes an installable plugin ZIP, Marketplace metadata, compatibility verification, a locally installed IntelliJ IDEA Ultimate 2026.2 smoke test, signing-ready release automation, and release documentation. Signing keys, certificates, Marketplace tokens, and other publishing credentials remain outside the repository.

The public identity is **Electivus Apex Log Viewer**, published by vendor **Electivus**, with the stable plugin ID `com.electivus.apexlogviewer`.

Release signing uses a long-lived Electivus-owned key and certificate chain supplied only to the protected CI release job through repository or environment secrets. Pull-request CI and local builds require no signing material and produce unsigned development artifacts. The release job uses the IntelliJ Platform Gradle Plugin `signPlugin` task and retains the signed ZIP as the Marketplace-ready artifact; the Marketplace publishing token is a separate secret and is not exercised by this implementation.

The IntelliJ plugin follows independent Semantic Versioning and is released only when that surface changes. Its first stable version is `1.0.0` after the complete first-release validation matrix passes, and release tags use `intellij-vX.Y.Z` so they do not collide with the VS Code extension's `vX.Y.Z` tags. Pre-release development builds remain CI artifacts unless a later decision introduces a public early-access channel.

## Verification strategy

Every relevant pull request runs deterministic Kotlin unit tests, mocked Tooling REST and Salesforce CLI process tests, IntelliJ Platform service and presentation tests, and the shared language-neutral conformance suite against both Kotlin and TypeScript runtimes. Plugin Verifier covers IntelliJ IDEA 2026.1 and 2026.2.

Real-org validation is risk-triggered. Changes to the IntelliJ plugin, Salesforce authentication or Tooling behavior, lifecycle and storage invariants, shared DTOs, or conformance fixtures require a pooled scratch-org lane before merge. Documentation-only and unrelated surface changes do not consume a pool lease. A release candidate must run the complete real-org and installed-plugin matrix on the candidate commit before an `intellij-vX.Y.Z` artifact is accepted.

Operating-system coverage is staged. Risk-triggered pull requests run the deterministic and applicable real-org coverage on Linux and Windows, including platform-specific Salesforce CLI discovery, process cancellation, and filesystem behavior. The release candidate adds macOS and completes real-org validation on Linux, Windows, and macOS. It also installs the built ZIP into the local Windows IntelliJ IDEA Ultimate 2026.2 instance for an end-to-end UI smoke test. Plugin Verifier continues to cover both IDEA 2026.1 and 2026.2 independently of the OS matrix.

## Open decisions

None.
