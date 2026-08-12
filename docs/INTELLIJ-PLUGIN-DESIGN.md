# IntelliJ Plugin design

Status: accepted

## Outcome

Add an Apex Log Viewer plugin for IntelliJ IDEA focused on Apex log discovery, acquisition, Unified Log Search, structured investigation, and Replay Handoff. The plugin is a first-class JetBrains surface with native UI and a Kotlin runtime, not a wrapper around the VS Code extension or the separately released `sf electivus` plugin.

The architectural rationale and runtime boundary are recorded in [ADR 0003](adr/0003-use-a-conformant-kotlin-runtime-for-intellij.md).

## Product scope

- IntelliJ IDEA Community and Ultimate 2026.1–2026.2.
- Compile against the IntelliJ IDEA 2026.1 and Java 21 baseline.
- Verify both supported IDE lines and smoke-test the locally installed IntelliJ IDEA Ultimate 2026.2.
- Other JetBrains IDEs are outside the first-release compatibility claim.

## Surfaces

- One lazily initialized project tool window for the Logs surface.
- A dedicated native editor for the Parsed Log Viewer.
- Open Raw Log opens the dependable local `.log` file in the standard text editor.
- Replay debugging is a **Replay Handoff** exposed as **Open in Illuminated Cloud 2** from the selected Logs row and the Parsed Log Viewer toolbar. Illuminated Cloud 2 owns and starts offline replay; when the integration is unavailable, Open Raw Log remains the fallback.

## Apex log recognition

The standard text editor remains the default editor for `.log` files. A log known to the Apex Log Lifecycle, or a local `.log` whose first ten logical lines within a bounded 64 KiB read contain the Salesforce markers `APEX_CODE,` or `|EXECUTION_STARTED|`, is eligible for an explicit **Open in Apex Log Viewer** action and alternate editor. This content check never scans the full file merely to decide editor eligibility.

Selecting a row from the Logs surface opens the dedicated parsed viewer directly because the lifecycle already establishes the file identity. Open Raw Log always returns to the standard text editor. Unrecognized `.log` files are never claimed by the plugin.

## Activation and project behavior

The project tool window is available in every IntelliJ IDEA project and initializes only when the user opens it or invokes an Apex Log Viewer action. Opening a project alone does not invoke the Salesforce CLI, call Salesforce, or create `apexlogs/`.

A missing `sfdx-project.json` does not block org selection, log acquisition, Unified Log Search, or parsed and raw log viewing. In that mode the IntelliJ project root remains the lifecycle workspace root and owns `apexlogs/`; capabilities that genuinely require Salesforce project metadata are omitted or shown as unavailable with an explanation. When present, valid Salesforce project metadata may supply project-specific defaults such as `sourceApiVersion`.

## Functional scope

The IntelliJ Logs surface includes CLI-default-aware org selection, refresh, pagination/infinite scroll, background acquisition for loaded pages, explicit Download All, a fixed initial set of natively resizable columns, basic filters and sorting, error and triage indicators, Parsed Log Viewer opening, raw-log opening, and Replay Handoff. Refresh never downloads the entire available backlog implicitly.

Unified Log Search combines visible catalog metadata with lifecycle-approved local log bodies, presents the first body match with a readable snippet and submatch ranges, distinguishes pending materialization, and composes with user, operation, status, and Errors-only filters plus sorting. Local results react immediately to each query edit. A query of at least three characters may begin paginating the remote catalog and materializing additional bodies after 750 milliseconds without another edit; shorter queries remain local-only and explain the remote-search threshold. Editing or clearing the query cancels the previous pass and prevents its stale completion from changing the current results. The query text is evaluated locally and is never sent to Salesforce.

Each remote search pass captures a stable logical catalog snapshot and follows the active ordering through that boundary. It pauses after finding 50 distinct logs that satisfy the query and active filters, or ends when the snapshot is exhausted. **Continue Search** resumes from the pass checkpoint to find the next batch of up to 50 matches; changing the query, filters, ordering, org, or catalog refresh starts a new pass rather than extending the old snapshot. Every successfully acquired body is atomically materialized through the normal Apex Log Lifecycle and is reusable by later searches, the Parsed Log Viewer, raw opening, and Replay Handoff.

Remote matches appear progressively in the ordered Logs table without stealing focus, and selection is preserved by log ID. A compact status strip reports the current phase, pages examined, bodies processed, distinct matches, and partial failures, and exposes the applicable **Cancel**, **Continue Search**, or **Try Again** action. The pass continues as an IntelliJ background task if the Logs tool window is hidden and remains bound to the open project; returning to the tool window shows the same live state.

The Parsed Log Viewer remains an Apex Log Viewer-owned surface rather than being replaced by Illuminated Cloud 2. It includes the existing Debug, SOQL, DML, and Errors perspectives, in-view search, triage diagnostics, selected-text copying, navigation to relevant events, and direct return to the dependable raw file.

Debug Flags, TraceFlag mutation, DebugLevel management, and remote Apex log cleanup are not part of the first IntelliJ release.

Tail views, streaming subscriptions, Tail settings, and Tail commands are not part of the IntelliJ plugin.

## Runtime and authentication

The IntelliJ-only Kotlin runtime implements Salesforce Tooling REST and the Apex Log Lifecycle while conforming to language-neutral fixtures shared with the TypeScript runtime. VS Code and `sf electivus` continue using `@alv/core`.

Replay Handoff is isolated behind an IntelliJ adapter that resolves `IlluminatedCloud.LogAnalyzer.Open` at runtime and invokes it through the platform Action System with the current project and dependable local log. If the body is not yet dependable, the action materializes it with visible progress before invoking the adapter; concurrent handoff for the same log reuses that work. The plugin does not import or reflect over Illuminated Cloud implementation classes and does not require Illuminated Cloud 2 to load. Missing or failed integration is classified as an unavailable optional capability rather than a log-opening failure.

The Salesforce CLI is the authentication broker through `sf org list --json` and `sf org display --json`. Access tokens remain memory-only and redacted from logs and diagnostics. The Kotlin runtime performs Tooling REST calls itself and may refresh credentials once after an authentication failure.

Missing CLI installation, no authenticated orgs, malformed CLI JSON, expired credentials, network failures, unsupported Salesforce responses, partial downloads, and cancellations are modeled as classified, actionable states rather than unhandled exceptions. An individual body failure is marked separately from a negative search match and does not prevent other bodies from being examined. A catalog-page failure pauses the pass without advancing its checkpoint, preserves completed results and materializations, and offers **Try Again** from the failed page. Authentication receives at most one automatic credential refresh before becoming an actionable failure. The UI preserves the last authoritative snapshot when a recoverable refresh fails and offers an explicit retry or setup action where applicable.

## Repository and execution boundary

The plugin lives in `apps/intellij-plugin/` as a self-contained Kotlin/Gradle IntelliJ Platform project with a checked-in Gradle wrapper. Language-neutral JSON schemas and fixtures live under `test/conformance/` and are consumed directly by both the Gradle and pnpm test lanes; generated Kotlin or TypeScript code is not the source of truth for the other runtime.

A project-scoped IntelliJ service owns the runtime, lifecycle workspace, selected org, cancellable operations, and disposal. Salesforce CLI processes, HTTP calls, filesystem work, parsing, triage, and full-log scanning run outside the Event Dispatch Thread under lifecycle-bound coroutine scopes; UI state is published back on the EDT. Closing a project or cancelling an IntelliJ progress task cancels its child work and prevents stale completion from mutating a newer project snapshot.

## Storage invariants

The IntelliJ surface uses the existing org-first `apexlogs/` store, sync-state contract, atomic materialization rules, legacy-file compatibility, and 24-hour local body retention policy. A body remains protected while represented by the active Logs state or open in a viewer; an older unprotected body may be purged safely and reacquired later. The plugin does not introduce another cache layout or search-only retention policy. Shared conformance fixtures cover canonical and legacy local-first resolution plus triage outputs; Kotlin and TypeScript runtime suites cover the additional path-safety, checkpoint, cancellation, partial-failure, and safe-purge invariants at their native public seams.

## Local full-log search

Local full-log search uses a Kotlin streaming scanner over only the explicit local paths approved by the Apex Log Lifecycle. It does not depend on IntelliJ project indexing and does not discover arbitrary `.log` files from the project.

The scanner preserves the current fixed-string, case-insensitive behavior. For each matching file it returns the first matching line, a display snippet, and submatch ranges. Work runs with bounded concurrency, supports prompt cancellation, reports lifecycle entries whose local materialization is still pending, and uses a small in-memory cache keyed by path, size, and modification time. The plugin does not package a native ripgrep binary.

## Configuration

Configuration parity between VS Code and IntelliJ is semantic rather than structural. A language-neutral contract keeps the meaning, defaults, and validation limits of shared runtime preferences aligned, initially including log page size, processing concurrency, and trace logging. Tail-only configuration is absent from IntelliJ.

The IntelliJ plugin exposes and persists these preferences through native JetBrains settings and state components. It does not read VS Code settings, reproduce VS Code key names as a storage format, or introduce a shared cross-IDE configuration file. The first release uses a fixed, behaviorally familiar column set. Native column resizing is available for the live table, but column order, visibility, and widths are not persisted settings or conformance requirements.

Persistence uses a hybrid scope. Log page size, processing concurrency, and trace logging are application-level user preferences. The selected org, search query, filters, ordering, and other restorable operational view state are project-level so concurrent projects cannot silently inherit one another's Salesforce target or investigation context. Reopening a project may rebuild results from the restored local state but does not resume a remote acquisition, reuse its old checkpoint, or initiate network access automatically; the user starts a new pass over a current snapshot. Access tokens and other credentials are excluded from all persisted settings and state.

## Telemetry

The first IntelliJ release sends no remote telemetry and therefore has no telemetry disclosure or opt-out setting. The existing language-neutral telemetry catalog remains authoritative for the VS Code surface and for any later, separately approved IntelliJ instrumentation.

## Diagnostics

The plugin keeps a bounded local buffer of structured operational diagnostics and exposes a command that opens a sanitized package in a preview. The user must explicitly choose to copy the package to the clipboard or save it to a selected file; the plugin never uploads diagnostics automatically.

The package may include plugin, IDE, OS, Java, and Salesforce CLI versions; coarse project capabilities; operation phases and classified outcomes; and bounded lifecycle state useful for support. It excludes source and Apex log content, search terms, usernames, aliases, org identifiers, instance URLs, access tokens, local paths, and raw trace output. The same allowlist and redaction rules apply both to the preview and the exported representation.

## Localization

Version 1.0.0 ships complete English and Brazilian Portuguese resource bundles, matching the languages already maintained by the VS Code extension. English is the fallback locale. All in-product actions, settings, notifications, dialogs, tooltips, empty states, and errors use resource keys; validation rejects missing locale keys and unintended hardcoded UI strings. The JetBrains plugin descriptor keeps its required Marketplace description and change notes as canonical English CDATA because the supported descriptor format does not define locale-specific variants for those elements; packaged privacy and support material is supplied in both languages.

## Distribution outcome

This implementation ends with a Marketplace-ready plugin but does not upload or submit it to JetBrains Marketplace. The deliverable includes an installable plugin ZIP, Marketplace metadata, compatibility verification, a locally installed IntelliJ IDEA Ultimate 2026.2 smoke test, signing-ready release automation, and release documentation. Signing keys, certificates, Marketplace tokens, and other publishing credentials remain outside the repository.

The public identity is **Electivus Apex Log Viewer**, published by vendor **Electivus**, with the stable plugin ID `com.electivus.apexlogviewer`.

Release signing uses a long-lived Electivus-owned key and certificate chain supplied only to the protected CI release job through repository or environment secrets. Pull-request CI and local builds require no signing material and produce unsigned development artifacts. The release job uses the IntelliJ Platform Gradle Plugin `signPlugin` task and retains the signed ZIP as the Marketplace-ready artifact; the Marketplace publishing token is a separate secret and is not exercised by this implementation.

The IntelliJ plugin follows independent Semantic Versioning and is released only when that surface changes. Its first stable version is `1.0.0` after the complete first-release validation matrix passes, and release tags use `intellij-vX.Y.Z` so they do not collide with the VS Code extension's `vX.Y.Z` tags. Pre-release development builds remain CI artifacts unless a later decision introduces a public early-access channel.

## Verification strategy

Every relevant pull request runs deterministic Kotlin unit tests, mocked Tooling REST and Salesforce CLI process tests, IntelliJ Platform service and presentation tests, and the shared language-neutral conformance suite against both Kotlin and TypeScript runtimes. Plugin Verifier covers IntelliJ IDEA 2026.1 and 2026.2.

Real-org validation is risk-triggered. Changes to the IntelliJ plugin, Salesforce authentication or Tooling behavior, lifecycle and storage invariants, shared DTOs, or conformance fixtures require a pooled scratch-org lane before merge. Documentation-only and unrelated surface changes do not consume a pool lease. A release candidate must run the complete real-org and installed-plugin matrix on the candidate commit before an `intellij-vX.Y.Z` artifact is accepted.

Operating-system coverage is staged. Risk-triggered pull requests run the deterministic and applicable real-org coverage on Linux and Windows, including platform-specific Salesforce CLI discovery, process cancellation, and filesystem behavior. The release candidate adds macOS and completes real-org validation on Linux, Windows, and macOS. It also installs the built ZIP into the local Windows IntelliJ IDEA Ultimate 2026.2 instance for an end-to-end UI smoke test. Plugin Verifier continues to cover both IDEA 2026.1 and 2026.2 independently of the OS matrix.

## Issue tracker alignment

Issue #1034 becomes the concise product requirement for the narrowed Logs, Unified Log Search, Parsed Log Viewer, and Replay Handoff scope. Its surviving child issues are updated to match this design. Debug Flags and DebugLevel issues #1044–#1045 and remote-cleanup issue #1046 are closed as not planned for this product; #1047 retains only bounded local diagnostics, and downstream validation and release issues lose the removed telemetry, cleanup, and Debug Flags requirements. The existing issue history and links remain available instead of replacing the epic with a second tracker tree.
