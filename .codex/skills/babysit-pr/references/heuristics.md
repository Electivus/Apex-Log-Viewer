# CI / Review Heuristics

## CI classification checklist

Treat as **branch-related** when logs clearly indicate a regression caused by the PR branch:

- Compile/typecheck/lint failures in files or modules touched by the branch
- Deterministic unit/integration test failures in changed areas
- Snapshot output changes caused by UI/text changes in the branch
- Static analysis violations introduced by the latest push
- Build script/config changes in the PR causing a deterministic failure

Treat as **likely flaky or unrelated** when evidence points to transient or external issues:

- DNS/network/registry timeout errors while fetching dependencies
- Runner image provisioning or startup failures
- GitHub Actions infrastructure/service outages
- Cloud/service rate limits or transient API outages
- Non-deterministic failures in unrelated integration tests with known flake patterns

If uncertain, inspect failed logs once before choosing rerun.

## Decision tree (fix vs rerun vs stop)

1. If PR is merged/closed: stop.
2. If GitHub is still showing Codex `eyes` on the PR body, treat the PR as **still in review** and do not declare it ready yet.
3. If GitHub is still waiting on a requested trusted AI reviewer (for example Copilot) and the watcher reports `review_signal.status == "awaiting_review"`, treat the PR as **still waiting on review** and do not declare it ready yet.
4. If there are failed checks:
   - Diagnose first.
   - If branch-related: fix locally, commit, push.
   - If likely flaky/unrelated and all checks for the current SHA are terminal: rerun failed jobs.
   - If checks are still pending: wait.
5. If flaky reruns for the same SHA reach the configured limit (default 3): stop and report persistent failure.
6. Independently, process any new human review comments and actionable GitHub Copilot, GitHub Code Quality, or Codex review bot feedback.

## Review comment agreement criteria

Address the comment when:

- The comment is technically correct.
- The comment is pertinent to the current PR.
- The change is actionable in the current branch.
- The requested change does not conflict with the user’s intent or recent guidance.
- The change can be made safely without unrelated refactors.

Do not auto-fix when:

- The comment is ambiguous and needs clarification.
- The request conflicts with explicit user instructions.
- The request is not pertinent to the current PR or would create churn without clear value.
- The proposed change requires product/design decisions the user has not made.
- The codebase is in a dirty/unrelated state that makes safe editing uncertain.

When a trusted bot suggestion is not pertinent or not worth acting on, prefer replying with the rationale and rejecting it explicitly instead of silently ignoring it.

## Stop-and-ask conditions

Stop and ask the user instead of continuing automatically when:

- The local worktree has unrelated uncommitted changes.
- `gh` auth/permissions fail.
- The PR branch cannot be pushed.
- CI failures persist after the flaky retry budget.
- Reviewer feedback requires a product decision or cross-team coordination.
