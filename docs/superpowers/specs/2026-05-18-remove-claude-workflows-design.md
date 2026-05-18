# Remove Claude Workflows Design

## Goal

Remove both GitHub Actions workflows that invoke Claude Code from this repository.

## Scope

Delete these workflow files:

- `.github/workflows/claude-code-review.yml`
- `.github/workflows/claude.yml`

Remove the two repository-security regression tests that specifically assert those Claude workflows exist:

- `Claude workflow only responds to trusted collaborators and has write permissions for repo actions`
- `Claude review workflow skips the action when the OAuth token is unavailable`

Remove any helper in `scripts/repo-security.test.js` that exists only for those deleted Claude-specific tests after confirming it has no remaining callers.

The change does not alter product code, packaging, release workflows, or CI gates unrelated to the removed Claude workflows.

## Current Behavior

`.github/workflows/claude-code-review.yml` runs Claude Code Review on pull request events for branches from this repository. It installs Bun, runs `anthropics/claude-code-action`, and contains handling for Claude usage-limit failures.

`.github/workflows/claude.yml` runs Claude Code when an owner, member, or collaborator mentions `@claude` in issue comments, pull request review comments, or pull request reviews.

`scripts/repo-security.test.js` contains two tests that inspect those workflow files and assert their security properties. Those tests are valid only while the Claude workflows exist.

## Proposed Behavior

Neither automatic Claude Code Review nor mention-triggered Claude Code runs should be configured in GitHub Actions after this change. Existing non-Claude CI workflows continue to run unchanged.

The repository-security suite should no longer assert security properties for removed Claude workflows. Generic workflow security checks, such as pinned action refs and dependency provenance checks, continue to apply to all remaining workflows.

## Approach

Remove the two workflow files outright instead of disabling their triggers or removing secrets. Deleting the files is the clearest repository state: there is no hidden or partially disabled Claude automation left for maintainers to reason about.

Remove only the two Claude-specific tests from `scripts/repo-security.test.js`. Keep shared helpers and generic workflow security tests. If a Claude-specific helper has no remaining callers after the test removal, delete that helper as part of the same cleanup.

## Verification

Verification should confirm:

- Git reports both Claude workflow files as deleted.
- `.github/workflows` no longer contains Claude workflow definitions.
- Remaining repository references to Claude are not operational workflow files.
- `npm run test:scripts` passes after the Claude-specific workflow assertions are removed.
- `scripts/repo-security.test.js` does not retain unused Claude-specific helper code.

No product runtime test suite is required because this is a GitHub Actions workflow removal plus aligned script-test cleanup.
