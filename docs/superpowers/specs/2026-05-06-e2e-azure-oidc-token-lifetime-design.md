# E2E Azure OIDC token lifetime CI fix design

## Context

PR #783 moved Cargo build outputs to Cargo's native `build.target-dir`. After the CLI E2E target-dir fix was pushed, the `Playwright E2E (scratch org)` GitHub Actions job still failed.

The failure was not in the CLI path:

- `Run CLI real-org E2E` completed successfully.
- The extension Playwright suite completed successfully with `7 passed`.
- The job failed during the post-suite telemetry validation query.

The failing log line was:

```text
AADSTS700024: Client assertion is not within its valid time range. Current time: 2026-05-06T17:49:02Z, assertion valid from 2026-05-06T17:38:34Z, expiry time of assertion 2026-05-06T17:43:34Z.
```

## Root cause

The workflow authenticates with `azure/login` before the CLI E2E and extension E2E steps. The Azure federated assertion used by Azure CLI is short-lived. The telemetry wrapper only needs Log Analytics access after the long Playwright child process finishes, so the first Log Analytics query can occur after the original assertion has expired.

## Goals

- Keep the existing telemetry validation behavior enabled when Azure OIDC and telemetry variables are configured.
- Avoid changing the real-org Playwright test coverage or proxy-lab architecture.
- Make the telemetry validation path robust against the observed Azure OIDC assertion lifetime failure.
- Add regression coverage so future workflow or telemetry runner changes do not reintroduce the same timing issue.

## Non-goals

- Replace Azure OIDC with stored credentials.
- Change scratch-org allocation or proxy-lab behavior.
- Broaden Playwright retries or hide real telemetry failures.
- Change production telemetry resources or event contracts.

## Recommended approach

Use a two-part fix:

1. Move the `Azure login for dedicated App Insights validation` step in `.github/workflows/e2e-playwright.yml` so it runs after the CLI E2E step and immediately before the extension Playwright/telemetry step.
2. In `scripts/run-playwright-e2e-telemetry.js`, resolve the Log Analytics workspace before launching the long Playwright child process. This pre-warms the Azure CLI access token while the federated assertion is still fresh, then the final telemetry validation can reuse that cached access token.

This keeps the Playwright child run inside the existing telemetry wrapper and proxy-lab flow, while reducing the time between Azure login and the first Log Analytics token acquisition.

## Alternatives considered

### Rerun the failed job only

This might pass if timing is favorable, but it leaves a deterministic timing hazard in the workflow. The previous run shows the suite can outlive the assertion window, so retrying alone is not a durable fix.

### Only move the Azure login step

Moving login later reduces the window, but the telemetry wrapper still may not ask Azure CLI for a Log Analytics token until after a long extension run. Pre-warming the workspace/token before Playwright is the safer small change.

### Re-authenticate after Playwright

Adding a second `azure/login` step after the Playwright child process would require splitting the telemetry wrapper's play/run and validation phases or duplicating logic in workflow shell. That is more invasive than keeping the behavior inside the telemetry runner.

## Implementation shape

- Add a telemetry runner helper that prepares workspace validation metadata before spawning Playwright.
- Reuse the prepared workspace metadata in `waitForTelemetry` instead of resolving the workspace again.
- Add a focused unit test proving the pre-warm step occurs before child spawn.
- Update the workflow guard test to assert Azure login occurs after `Run CLI real-org E2E` and before `Run Playwright E2E`.

## Verification plan

- `node --test scripts/run-playwright-e2e-telemetry.test.js scripts/cli-e2e-workflow.test.js`
- `npm run test:scripts`
- Push the PR branch and resume `babysit-pr` until PR #783 reaches a terminal state.

## Risks and mitigations

- **Risk:** The final Log Analytics token could still expire during a very long ingestion wait.
  - **Mitigation:** The observed failure was the federated assertion before first token acquisition. Pre-warming obtains the access token early. Existing validation attempts remain bounded by the runner's retry settings.
- **Risk:** Workflow ordering regressions could reintroduce the issue.
  - **Mitigation:** Add a workflow guard test for the Azure login step position.
- **Risk:** Refactoring telemetry workspace resolution could change query targeting.
  - **Mitigation:** Keep the existing query construction and add only a small prepared-context path around `resolveWorkspaceInfo`.
