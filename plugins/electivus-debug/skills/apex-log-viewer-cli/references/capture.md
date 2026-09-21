# Capture enough evidence

```text
sf electivus user search --query "Ada Lovelace" --target-org my-org --limit 10 --json
sf electivus debug-level list --target-org my-org --json
sf electivus trace-flag status --target-org my-org --current-user --json
```

Choose exactly one trace target: `--current-user`, `--user-id <005...>`, `--automated-process`, or `--platform-integration`. Establish the actual executing identity; not every Flow or async operation runs as Automated Process. Async jobs can emit separate transactions/logs.

Reuse adequate active traces and levels. For authorized changes, inspect public help, preview the exact operation, then apply it:

```text
sf electivus trace-flag apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --dry-run --json
sf electivus trace-flag apply --target-org my-org --current-user --debug-level ALV_DEBUG --ttl-minutes 30 --yes --json
```

Use a bounded reproduction window (30 minutes is the default). Record changes and expiration. Applying can update an existing flag; removing a target can delete multiple flags. Prefer expiry over incidental cleanup, and do not promise automatic restoration. Restore settings only with a precise supported operation within authorization.

Choose logging categories for the question. Heap events require Apex Code FINER or above; query plans need Database FINEST. Inspect actual headers and parser coverage. Increase only missing categories rather than setting everything to FINEST and increasing truncation risk. Consult `debug-level create/update --help` for supported flags.

Reproduce through the actual user flow or targeted `sf apex run test`. Anonymous Apex and deployments must already be authorized. Installed Salesforce skills may assist, but are not required. The bundled MCP execution tool is disabled.

After reproduction completes, sync and search again. Correlate separate async logs using identifiers and code evidence, not time proximity alone. Salesforce can remove lines from anywhere in large logs: inspect completeness markers before trusting totals. See the [official Debug Log guide](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_debugging_debug_log.htm); do not hardcode an old 2 MB limit.
