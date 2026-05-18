# E2E Observability And Maintenance Design

## Context

The PR that removes the SQLite log index is blocked by the Playwright scratch-org E2E job. The remote run reaches `debugFlagsPanel.e2e.spec.ts` and then spends roughly one full Playwright test timeout before reporting failure. Local reproduction was initially misleading because the Codex shell had a Dev Hub auth URL configured and did not expose the Salesforce CLI on the Node 24 `PATH`, so the fixture failed before reaching the test body.

## Goals

- Make Salesforce CLI setup failures in E2E actionable without exposing auth tokens.
- Make `debugFlagsPanel.e2e.spec.ts` fail near the operation that is not ready instead of consuming the global 15 minute test timeout.
- Keep the change scoped to E2E test helpers/specs and avoid runtime behavior changes.

## Non-Goals

- Do not change production extension, CLI, or shared runtime behavior.
- Do not alter scratch-org pool semantics.
- Do not print raw `sf` stdout or stderr, because verbose auth output can include secrets.

## Design

### Salesforce CLI diagnostics

`test/e2e/utils/sfCli.ts` should preserve the existing secret-safe behavior, but enrich command failures with non-secret execution metadata. When `sf` fails without parseable JSON, the error should include the process exit code or signal if available. When the failure looks like a missing executable (`ENOENT`), the error should say that the command could not be found and recommend checking `PATH` or installing Salesforce CLI for the Node/test environment.

This keeps the common authenticated-org errors readable while avoiding raw output that could leak auth URLs or access tokens.

### Debug flags panel readiness

`test/e2e/specs/debugFlagsPanel.e2e.spec.ts` should stop using default, unbounded Playwright action waits for key controls. Before clicking Apply and Remove, the test should wait explicitly for the target button to be enabled with a bounded timeout. The final Tail entrypoint assertion should also use an explicit timeout.

If the panel never selects a debug level, never finishes org loading, or cannot make a target actionable, the failure should point at the specific disabled control rather than timing out at the test-level deadline.

## Testing Strategy

- Add focused tests for the safe `sf` failure formatting so `ENOENT`, exit code, and signal metadata are covered without invoking real Salesforce CLI.
- Run the targeted helper test to observe red/green behavior.
- Run the relevant E2E command locally with Node 24 and a corrected Salesforce CLI `PATH`; if local Dev Hub configuration still blocks the run, report the exact blocker separately from the remote timeout.
- Fetch the remote job log or artifacts when available to compare the new failure location with the previous 15 minute timeout.
