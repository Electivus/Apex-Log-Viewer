---
name: apex-debug-performance
description: Diagnose Salesforce performance and governor-limit problems from an Electivus-synchronized apexlogs corpus, including CPU, repeated SOQL/DML, heap, recursion and before/after comparisons. Use to locate expensive executions, explain their cost and verify targeted optimizations.
---

# Investigate Apex performance

Find relevant executions across the corpus before profiling individual files. Correct and verify when requested, distinguishing measurements from hypotheses.

## Select executions

For current org activity run `sf electivus doctor --target-org my-org --json` and `sf electivus log sync --target-org my-org --json` in the workspace. Check the inner sync result for partial failure even when outer `status` is zero. Use `orgLogsRoot`; older plugins expose `apexlogsRoot` and `safeTargetOrg` through `log status`. Check public help for unfamiliar capabilities.

For supplied/offline logs start directly with those paths, without org access or software installation. Reuse the corpus across searches; subsequent syncs collect new reproduction activity. Use `--force-full` for retained history missing behind the checkpoint, not routine searches.

```bash
rg --no-ignore -l -F -g '*.log' -- 'CheckoutService' '/absolute/orgLogsRoot'
rg --no-ignore -n -C 3 -e 'LIMIT_USAGE_FOR_NS|CUMULATIVE_LIMIT_USAGE|FATAL_ERROR' -- '/absolute/path/candidate.log'
```

The corpus is normally gitignored, so use `--no-ignore`. Find filenames before printing content. Read [references/performance.md](references/performance.md) for legacy scoping, capture requirements and comparison.

## Analyze selected paths

When Certinia MCP is available, discover actual tool names (clients may prefix them) and use absolute paths:

1. `apexlog_get_summary`: completeness, captured categories, fatal errors, transaction limits and namespace usage.
2. `apexlog_list_slow_operations`: self time, call count and slowest call; narrow type/category/namespace as needed.
3. `apexlog_list_limit_risks`: reported threshold (default 80%) and actual used/max values.

The bundled MCP disables anonymous Apex. Capture stays with `sf electivus`; authorized tests/reproductions use existing Salesforce/project tooling. If MCP is unavailable, continue with local event/limit excerpts and explain unavailable measurements. Installation must be in scope.

Correlate cost with source and input size. Separate wall time from CPU, self time from inclusive time, normal repeated work from a proven loop, and captured zero from insufficient logging. Partial logs cannot establish complete totals.

## Optimize and verify

Make the smallest supported optimization when requested, preserving business behavior and bulk semantics. Compare equivalent transaction type, input volume and log levels. Run focused tests and an authorized org reproduction, then resync. Fewer log lines or shorter wall time alone do not prove CPU improvement.

Capture changes/deployment require applicable authorization; reuse permission already granted. Other Salesforce skills are optional assistance. Report evidence, dominant cost, confidence, change, measured before/after values and remaining validation. Share short relevant excerpts without full bodies or unrelated sensitive data.
