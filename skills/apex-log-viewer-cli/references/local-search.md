# Search the synchronized corpus

Search inside the selected org's `orgLogsRoot`. It may not exist when no logs were saved. `apexlogs/` and `*.log` are normally gitignored: pass `--no-ignore`, confined to log directories.

```bash
# Candidate filenames first, using a literal business identifier or error.
rg --no-ignore -l -F -g '*.log' -- 'ORDER-4821' '/absolute/orgLogsRoot'
# Bounded context in a selected file; -n is the physical log line.
rg --no-ignore -n -C 4 -F -- 'ORDER-4821' '/absolute/path/candidate.log'
# Structural events intentionally use a regular expression.
rg --no-ignore -n -m 30 -e '\|(FATAL_ERROR|EXCEPTION_THROWN|FLOW_ELEMENT_ERROR|CUMULATIVE_LIMIT_USAGE|LIMIT_USAGE_FOR_NS)\|' -- '/absolute/path/candidate.log'
```

`-m` limits matches per file, not the entire corpus. Find filenames before printing content across thousands of files. Use `--json` for structured matches or `-l -0` with NUL-aware consumers when passing filenames. Exit 1 is no matches; exit 2 is an error.

Repeated literal `-e` arguments mean OR. For AND, search the first candidate set for the second condition. With `-F`, treat the search term literally without regex escaping.

Canonical files are `apexlogs/orgs/<safeTargetOrg>/logs/<day>/<logId>.log`. Legacy files are directly under `apexlogs/` as `<safeTargetOrg>_<logId>.log`. Search them using the exact safe org from status, `--max-depth 1`, and the glob `<safeTargetOrg>_*.log`. Deduplicate by log ID, preferring canonical files. Never include another org to fill a missing result.

Before concluding an event is absent, check directory/file count, ignore handling, identity and sync health. Broaden the anchor when appropriate, then investigate capture levels, trace target, retention or separate asynchronous execution. `--force-full` reconciles retained history, not inadequate logging.
