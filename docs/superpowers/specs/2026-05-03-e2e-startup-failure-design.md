# E2E Startup Failure and PR Gate Design

## Context

PR #770 adds MITM proxy validation to the real-org Playwright E2E workflow. GitHub showed the normal PR check rollup as green, but the E2E workflow run existed separately with conclusion `startup_failure` and no jobs or check runs. The run page annotation identified the root cause:

> The action `azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43` is not allowed in `Electivus/Apex-Log-Viewer` because all actions must be from a repository owned by Electivus, created by GitHub, or match one of the configured allowlist patterns. The allowlist includes `azure/login@93381592711f247e165c389ebb30b596c84cdc48`.

The current branch and `origin/main` both pin `azure/login` to the disallowed dereferenced commit for the `v3.0.0` tag. The org allowlist instead permits the tag object SHA for `v3.0.0`, which GitHub Actions accepts as a full-length SHA in this repository policy.

## Goals

- Make the E2E workflow start again under the current org action allowlist.
- Prevent accidental reintroduction of the disallowed `azure/login` pin in the repository workflow.
- Keep PR #770 blocked until the hidden startup failure is resolved.
- Improve local PR monitoring so `startup_failure` check suites without check runs are not treated as green.

## Non-Goals

- Change the MITM proxy lab design or test behavior.
- Change org/repository rulesets directly from this branch.
- Replace Azure telemetry validation.

## Design

### Workflow pin

Update `.github/workflows/e2e-playwright.yml` so the Azure login step uses the org-allowed pin:

```yaml
uses: azure/login@93381592711f247e165c389ebb30b596c84cdc48
```

This is the smallest workflow change that addresses the actual startup blocker. It does not alter job conditions, secrets, telemetry behavior, or MITM proxy execution.

### Repository regression test

Extend `scripts/cli-e2e-workflow.test.js` with a guard that parses the E2E workflow and asserts the Azure login step uses the allowed full-length SHA. This keeps `npm run test:scripts` from passing after a Dependabot bump changes the pin back to a SHA outside the org allowlist.

### PR monitoring hardening

Update the local `babysit-pr` skill scripts to detect GitHub Actions check suites on the PR head commit that have a failed conclusion, including `startup_failure`, even when `latest_check_runs_count` is `0`. Such suites should be reported as failed CI instead of omitted from the ready/green state.

The implementation should reuse existing GraphQL/REST normalization where possible and include tests using a synthetic startup-failure check suite with no check runs.

### Operational branch protection note

The repo ruleset currently does not require status checks. The code branch can document and surface this, but the actual fix is an org/repo settings change: require the E2E workflow/status checks in the active ruleset if merges must be blocked by GitHub itself.

## Verification

- Run `npm run test:scripts` after the repository workflow/test change.
- Push the workflow fix and rerun/trigger the E2E workflow for PR #770.
- Confirm the new run creates jobs instead of `startup_failure`.
- Run the relevant `babysit-pr` tests after local skill hardening.
- Re-run `babysit-pr` against PR #770 and verify it no longer treats hidden startup failures as green.
