---
name: apex-debug-investigate
description: Find the relevant Salesforce transaction in a synchronized local apexlogs corpus and investigate functional failures, Apex exceptions, trigger/Flow interactions or failing tests through evidence, code correction and validation. Use when an error or business identifier is known but the log ID is not.
---

# Investigate Salesforce failures

Own the loop from a symptom to evidence, the smallest supported correction and verification within the requested scope. Start with bulk sync and local content search.

## Establish the corpus

Infer workspace, intended org and clues from the request/project. Ask only for missing context that matters. Record IDs, order numbers, exception fragments and class names can locate the transaction without a log ID.

For current org activity run `sf electivus doctor --target-org my-org --json`, then `sf electivus log sync --target-org my-org --json` in the workspace. Inspect `result.status`, `failed`, `failures` and `orgLogsRoot`: outer `status: 0` does not prove sync completeness. Subsequent syncs are incremental. `--force-full` reconciles retained history missing behind a checkpoint; do not use it for every search. Diagnose persistent sync errors before retrying.

For supplied/offline logs, read directly without requiring auth or installing the CLI. Older versions expose `apexlogsRoot` and `safeTargetOrg` through `log status`; use public `--help` to confirm unfamiliar capabilities. Software installation or updates must be in scope.

## Find the execution

Read [references/investigation.md](references/investigation.md) for recipes and interpretation. Find candidates first with local tools, then inspect relevant context:

```bash
rg --no-ignore -l -F -g '*.log' -- 'business-id' '/absolute/orgLogsRoot'
```

Logs are normally gitignored, hence `--no-ignore`. Scope to the selected org, include its legacy root-level files when present, and deduplicate by log ID. Keep physical file lines separate from Apex source lines.

## Explain, correct, verify

1. Establish entry point, failing stage and actual outcome. `EXCEPTION_THROWN` and `triage.hasErrors` can include caught exceptions.
2. Read surrounding events, inner exceptions, limits and implicated source. For async work, state the identifiers linking separate transactions.
3. If available, use Certinia `apexlog_get_summary` with the absolute local log path. Discover the exposed tool name, which can include a client/plugin prefix. Substantiate summaries with excerpts; MCP is optional.
4. Separate confirmed cause, hypothesis and missing evidence. Repeated queries alone do not prove a loop; absent errors in incomplete logs do not prove success.
5. When correction is requested, change the smallest causally relevant code and run focused tests using repo/Salesforce tooling. Other installed skills may assist but are not mandatory dependencies.
6. For an authorized org rerun/deployment, reproduce and sync again, comparing the same scenario. Local source edits do not prove the org runs them. Otherwise name the validation that remains unavailable.

Capture changes, deployment and anonymous execution must stay within authorization already granted; reuse that authorization. For missing evidence see [capture guidance](references/investigation.md#when-new-capture-is-needed). Do not delete logs incidentally.

Report transaction/log IDs, file-and-line evidence, diagnosis and confidence, correction if any, and actual verification. Reading needed content is part of debugging; share only short relevant excerpts, never auth material.
