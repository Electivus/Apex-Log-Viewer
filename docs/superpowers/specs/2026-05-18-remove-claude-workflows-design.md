# Remove Claude Workflows Design

## Goal

Remove both GitHub Actions workflows that invoke Claude Code from this repository.

## Scope

Delete these workflow files:

- `.github/workflows/claude-code-review.yml`
- `.github/workflows/claude.yml`

The change does not alter product code, tests, packaging, release workflows, or other CI gates.

## Current Behavior

`.github/workflows/claude-code-review.yml` runs Claude Code Review on pull request events for branches from this repository. It installs Bun, runs `anthropics/claude-code-action`, and contains handling for Claude usage-limit failures.

`.github/workflows/claude.yml` runs Claude Code when an owner, member, or collaborator mentions `@claude` in issue comments, pull request review comments, or pull request reviews.

## Proposed Behavior

Neither automatic Claude Code Review nor mention-triggered Claude Code runs should be configured in GitHub Actions after this change. Existing non-Claude CI workflows continue to run unchanged.

## Approach

Remove the two workflow files outright instead of disabling their triggers or removing secrets. Deleting the files is the clearest repository state: there is no hidden or partially disabled Claude automation left for maintainers to reason about.

## Verification

Verification should confirm:

- Git reports both Claude workflow files as deleted.
- `.github/workflows` no longer contains Claude workflow definitions.
- Remaining repository references to Claude are not operational workflow files.

No product test suite is required because this is a GitHub Actions workflow removal only.
