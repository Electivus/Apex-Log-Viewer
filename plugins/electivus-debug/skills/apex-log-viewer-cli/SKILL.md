---
name: apex-log-viewer-cli
description: Operate sf electivus to synchronize a local Apex log corpus, inspect cache health, triage logs, and manage debug levels or trace flags. Use for Electivus CLI commands and capture setup; use an investigation or performance workflow to explain a failure or bottleneck.
---

# Apex Log Viewer CLI

The CLI and VS Code extension share a local log store and TypeScript core. Run from the Salesforce workspace owning `apexlogs/`, or pass `--workspace-root` where supported.

## Start from the task

For current org activity, resolve the intended org and synchronize its available logs in bulk. For supplied files or explicitly offline work, read local files directly; authentication and Doctor are not prerequisites.

Before org-backed operations:

```text
sf electivus doctor --target-org my-org --json
sf electivus log status --target-org my-org --json
sf electivus log sync --target-org my-org --json
```

Read Doctor's runtime version and checks. Resolve ambiguous orgs before remote operations and carry `--target-org` through subsequent commands. Check public `--help` before relying on a capability an older version might lack.

If installation or an update is requested or authorized, use the corresponding command:

```text
sf plugins install @electivus/plugin-electivus
sf plugins install @electivus/plugin-electivus@latest --force
```

Explain observed missing capabilities. Do not install or update software just to inspect supplied files.

## Synchronize, then search locally

The first sync enumerates available logs and saves their bodies. Later syncs fetch activity since the shared checkpoint. Reuse the corpus for multiple searches; discover transactions by local content rather than listing and downloading individual logs.

Salesforce CLI wraps values in `result`. **An outer `status: 0` can contain a partial sync.** Read `result.status`, `failed`, `failures`, and `checkpointAdvanced`. Failure entries contain log IDs and stable codes. Repeating sync can recover a partial run; diagnose persistent authentication or disk failures rather than retrying indefinitely.

Use `orgLogsRoot` as the canonical search directory and consider legacy files under `apexlogsRoot`. On older plugins derive the canonical path from `log status`'s `apexlogsRoot` and `safeTargetOrg`. Read [references/local-search.md](references/local-search.md) for search recipes, org isolation and empty-result diagnosis.

Use `--force-full` to reconcile retained history missing behind a checkpoint, such as after local deletion. It re-enumerates records and reuses existing bodies; it cannot recover logs expired from Salesforce. Successful incremental sync does not prove complete historical coverage.

## Inspect selected logs

```text
sf electivus log resolve --log-id 07L000000000001AAA --target-org my-org --json
sf electivus log triage --log-id 07L000000000001AAA --target-org my-org --json
```

`resolve` finds a cached file. `triage` can acquire a missing body and identifies suspicious events, not proven failed transactions: `EXCEPTION_THROWN` can be caught. Examine surrounding events before interpreting `hasErrors`.

Read necessary excerpts as part of diagnosis. `log read --max-bytes 20000` returns a bounded prefix; for events later in the log, use local searches and line-based reads. Report IDs, paths and minimal evidence without credentials or unrelated payloads. `log list` remains available for remote metadata checks. Do not invent the removed `logs search` or `logs index` commands.

## Capture and org writes

Read [references/capture.md](references/capture.md) when logs are absent or lack enough detail. It covers execution identities, trace flags, category levels and reproduction.

`trace-flag apply/remove`, `debug-level create/update/delete`, and `log delete` change Salesforce state. Stay within the user's authorized scope, reuse authorization already given, preview with `--dry-run`, then execute an authorized write with `--yes`. Diagnosis alone does not authorize deployment, arbitrary Apex execution or deleting logs. `log delete --scope all` requires intent to delete all matching logs.

Prefer typed commands. For a read-only gap use `sf electivus tooling query --soql "..." --target-org my-org --json` or `tooling get --path "..."`. Never mutate through raw Tooling requests.

## Updates and result

Update skills only when requested. For bundled copies repeat the original `sf electivus skill install` agent/scope/selection with `--force`; `--all` selects the catalog and repeatable `--skill` selects names. Plugin updates do not refresh installed copies. For repository installations use `npx skills update apex-log-viewer-cli --project -y`, or `--global` for that requested scope. Identify an unknown installation channel before choosing its updater.

Finish with the resolved org, sync outcome and coverage limitations, paths or IDs used, findings and validation. Do not dump full logs or authentication material.
