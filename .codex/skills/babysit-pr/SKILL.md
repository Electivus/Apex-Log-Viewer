---
name: babysit-pr
description: Use when the user asks to monitor a GitHub pull request, watch CI, handle review comments, or keep an eye on failures and feedback on an open PR.
---

# PR Babysitter

## Objective
Babysit a PR persistently until one of these terminal outcomes occurs:

- The PR is merged or closed.
- CI is successful, there are no unaddressed review comments surfaced by the watcher, there are no potential merge conflicts (PR is mergeable / not reporting conflict risk), and the watcher is not still reporting an AI reviewer `in_review` or `awaiting_review` signal.
- A situation requires user help (for example CI infrastructure issues, repeated flaky failures after retry budget is exhausted, permission problems, or ambiguity that cannot be resolved safely).

Do not stop merely because a single snapshot returns `idle` while checks are still pending.

## Inputs
Accept any of the following:

- No PR argument: infer the PR from the current branch (`--pr auto`)
- PR number
- PR URL

## Core Workflow

1. When the user asks to "monitor"/"watch"/"babysit" a PR, start with the watcher's continuous mode (`--watch`) unless you are intentionally doing a one-shot diagnostic snapshot.
2. Run the watcher script to snapshot PR/CI/review state (or consume each streamed snapshot from `--watch`).
3. Inspect the `actions` list in the JSON response.
4. Inspect `review_signal.status`. If it is `in_review`, treat the PR status as `in review` even when there are no comments yet. If it is `awaiting_review`, treat the PR as still waiting on a requested trusted AI reviewer.
5. If `diagnose_ci_failure` is present, inspect failed run logs and classify the failure.
6. If the failure is likely caused by the current branch, patch code locally, commit, and push.
7. If `process_review_comment` is present, inspect surfaced review items and triage them before changing code.
8. If a review item is actionable, correct, pertinent, and in scope for the PR, patch code locally, commit, and push.
9. If a review item is important but not actually part of the PR's scope, record it as a follow-up issue instead of expanding the PR.
10. If a review item is incorrect, already handled, not pertinent, or otherwise non-actionable, mark it as intentionally rejected/ignored and continue watching.
11. If the failure is likely flaky/unrelated and `retry_failed_checks` is present, rerun failed jobs with `--retry-failed-now`.
12. If both actionable review feedback and `retry_failed_checks` are present, prioritize review feedback first; a new commit will retrigger CI, so avoid rerunning flaky checks on the old SHA unless you intentionally defer the review change.
13. On every loop, verify mergeability / merge-conflict status (for example via `gh pr view`) in addition to CI and review state.
14. After any push, rerun, or follow-up issue capture, immediately return to step 1 and continue polling on the updated SHA/state.
15. If you had been using `--watch` before pausing to patch/commit/push, relaunch `--watch` yourself in the same turn immediately after the push (do not wait for the user to re-invoke the skill).
16. Repeat polling until the PR is green + review-clean + mergeable + not `in_review`, `stop_pr_closed` appears, or a user-help-required blocker is reached.
17. Maintain terminal/session ownership: while babysitting is active, keep consuming watcher output in the same turn; do not leave a detached `--watch` process running and then end the turn as if monitoring were complete.

## Commands

### One-shot snapshot

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --once
```

### Continuous watch (JSONL)

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --watch
```

### Trigger flaky retry cycle (only when watcher indicates)

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --retry-failed-now
```

### Explicit PR target

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_watch.py --pr <number-or-url> --once
```

### List current actionable review bot feedback items

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --list
```

### Acknowledge all currently listed actionable review bot feedback with `👍` and resolve open actionable review bot threads you've handled

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --ack-all
```

### Dry-run an acknowledgement pass before mutating GitHub state

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --ack-all --dry-run
```

### Create a follow-up issue for out-of-scope actionable review bot feedback, then mark it captured with `👍`

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --follow-up <item-id> --issue-label follow-up
```

### Dry-run follow-up issue creation before mutating GitHub state

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --follow-up <item-id> --issue-label follow-up --dry-run
```

### Reply on a review thread before resolving it

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --ack <item-id> --reply-body "Handled in the latest PR update."
```

### Reject a non-pertinent review suggestion but keep the thread open while you document the rationale

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --reject <item-id> --reply-body "Reviewed this suggestion and we are intentionally keeping the current implementation for this PR." --no-resolve
```

### Reject a non-pertinent review suggestion and close the thread after documenting why

```bash
python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --reject <item-id> --reply-body "Reviewed this suggestion and we are intentionally keeping the current implementation for this PR."
```

`gh_pr_codex_feedback.py` remains available as a backward-compatible alias, but prefer the neutral `gh_pr_review_feedback.py` entrypoint for GitHub Copilot, GitHub Code Quality, and Codex review feedback.

## CI Failure Classification
Use `gh` commands to inspect failed runs before deciding to rerun.

- `gh run view <run-id> --json jobs,name,workflowName,conclusion,status,url,headSha`
- `gh run view <run-id> --log-failed`

Prefer treating failures as branch-related when logs point to changed code (compile/test/lint/typecheck/snapshots/static analysis in touched areas).

Prefer treating failures as flaky/unrelated when logs show transient infra/external issues (timeouts, runner provisioning failures, registry/network outages, GitHub Actions infra errors).

If classification is ambiguous, perform one manual diagnosis attempt before choosing rerun.

Read `.codex/skills/babysit-pr/references/heuristics.md` for a concise checklist.

## Review Comment Handling
The watcher surfaces review items from:

- PR issue comments
- Inline review comments
- Review submissions (COMMENT / APPROVED / CHANGES_REQUESTED)

It intentionally surfaces trusted reviewer bot feedback (for example comments/reviews from the Codex reviewer login, which GitHub may emit as `chatgpt-codex-connector` or `chatgpt-codex-connector[bot]`; the Copilot reviewer login, which GitHub may emit as `copilot-pull-request-reviewer`, `copilot-pull-request-reviewer[bot]`, or `Copilot` in some REST review-comment payloads; and `github-code-quality`) in addition to human reviewer feedback. Most unrelated bot noise should still be ignored.
For safety, the watcher only auto-surfaces trusted human review authors (for example repo OWNER/MEMBER/COLLABORATOR, plus the authenticated operator) and approved review bots such as Codex, Copilot, and GitHub Code Quality.
On a fresh watcher state file, existing pending review feedback may be surfaced immediately (not only comments that arrive after monitoring starts). This is intentional so already-open review comments are not missed.
Separately, the watcher also inspects PR reactions. If the PR body has an `eyes` reaction from `chatgpt-codex-connector[bot]`, the watcher exposes `review_signal.status = "in_review"` and may emit `review_in_progress` in `actions`. Treat that as Codex still reviewing the PR, not as review feedback that needs a code change yet.
Separately, the watcher also inspects requested trusted AI reviewers. If GitHub still shows Copilot or another trusted AI reviewer as requested and that reviewer has not submitted feedback yet, the watcher exposes `review_signal.status = "awaiting_review"` and may emit `awaiting_review` in `actions`. Treat that as "still waiting on review", not as review feedback that already needs a code change.

Not every trusted bot suggestion should be implemented. Triage trusted AI review feedback the same way you would triage human review feedback: apply it only when it is technically correct, pertinent, and in scope for the PR.

When you agree with a comment and it is actionable:

1. Patch code locally.
2. Commit with `fix(pr): address PR review feedback (#<n>)`.
3. Push to the PR head branch.
4. Prefer replying in the GitHub review thread with a short status update before resolving it (for example what changed, or that it was captured as follow-up). Then react with `👍` to the relevant actionable review bot feedback and resolve the handled review threads. Prefer `python3 .codex/skills/babysit-pr/scripts/gh_pr_review_feedback.py --pr auto --ack-all --dry-run` first, then rerun without `--dry-run` once you are satisfied.
5. Resume watching on the new SHA immediately (do not stop after reporting the push).
6. If monitoring was running in `--watch` mode, restart `--watch` immediately after the push in the same turn; do not wait for the user to ask again.

Triage review feedback explicitly before touching code:

1. In scope for the PR and correct: fix it in the PR.
2. Important but out of scope for the PR: do not silently widen the PR. First look for an existing issue covering the same problem; if none exists, create a follow-up issue and keep the PR focused.
3. Incorrect, already addressed, not pertinent to the current PR, or not worth acting on: reject it explicitly and continue watching.

When a comment is important but out of scope for the current PR:

1. Search for an existing issue that already tracks the same problem.
2. If none exists, create a follow-up issue from the feedback item with `gh_pr_review_feedback.py --follow-up ...`.
3. If the item is a review thread, reply in-thread with the tracking issue link so future readers can see where the work moved.
4. React with `👍` on the source feedback once it has been captured as follow-up; if the item is an actionable review bot thread, resolve the thread after the issue is created unless the thread should stay open.
5. Resume watching immediately. Do not implement the out-of-scope change in the current PR unless the user explicitly broadens scope.

If you disagree or the comment is non-actionable/already addressed, prefer documenting that explicitly with `gh_pr_review_feedback.py --reject ...`. Use `--no-resolve` when you want the thread to remain open for visibility; otherwise reply with the rationale and resolve the thread to close the loop.
If a code review comment/thread is already marked as resolved in GitHub, treat it as non-actionable and safely ignore it unless new unresolved follow-up feedback appears.
If you intentionally reject actionable review bot feedback, react with `👎` using `gh_pr_review_feedback.py --reject ...`. Leave the thread open unless you are intentionally closing the loop after documenting why the suggestion should not be applied.

## Git Safety Rules

- Work only on the PR head branch.
- Avoid destructive git commands.
- Do not switch branches unless necessary to recover context.
- Before editing, check for unrelated uncommitted changes. If present, stop and ask the user.
- After each successful fix, commit and `git push`, then re-run the watcher.
- If you interrupted a live `--watch` session to make the fix, restart `--watch` immediately after the push in the same turn.
- Do not run multiple concurrent `--watch` processes for the same PR/state file; keep one watcher session active and reuse it until it stops or you intentionally restart it.
- A push is not a terminal outcome; continue the monitoring loop unless a strict stop condition is met.

Commit message defaults:

- `fix(pr): fix CI failure on PR #<n>`
- `fix(pr): address PR review feedback (#<n>)`

## Monitoring Loop Pattern
Use this loop in a live Codex session:

1. Run `--once`.
2. Read `actions`.
3. First check whether the PR is now merged or otherwise closed; if so, report that terminal state and stop polling immediately.
4. Check CI summary, new review items, and mergeability/conflict status.
5. If `review_signal.status == "in_review"` or `actions` includes `review_in_progress`, report the PR as `in review` and keep waiting; do not treat it as ready. If `review_signal.status == "awaiting_review"` or `actions` includes `awaiting_review`, report that the PR is still waiting on a trusted AI reviewer.
6. Diagnose CI failures and classify branch-related vs flaky/unrelated.
7. Process actionable review comments before flaky reruns when both are present; if a review fix requires a commit, push it and skip rerunning failed checks on the old SHA.
8. Retry failed checks only when `retry_failed_checks` is present and you are not about to replace the current SHA with a review/CI fix commit.
9. If you pushed a commit or triggered a rerun, report the action briefly and continue polling (do not stop).
10. After a review-fix push, proactively restart continuous monitoring (`--watch`) in the same turn unless a strict stop condition has already been reached.
11. If everything is passing, mergeable, there are no unaddressed review items or unresolved review threads, and the watcher is not still reporting `in_review` or `awaiting_review`, report success and stop.
12. If blocked on a user-help-required issue (infra outage, exhausted flaky retries, unclear reviewer request, permissions), report the blocker and stop.
13. Otherwise sleep according to the polling cadence below and repeat.

When the user explicitly asks to monitor/watch/babysit a PR, prefer `--watch` so polling continues autonomously in one command. Use repeated `--once` snapshots only for debugging, local testing, or when the user explicitly asks for a one-shot check.
Do not stop to ask the user whether to continue polling; continue autonomously until a strict stop condition is met or the user explicitly interrupts.
Do not hand control back to the user after a review-fix push just because a new SHA was created; restarting the watcher and re-entering the poll loop is part of the same babysitting task.
If a `--watch` process is still running and no strict stop condition has been reached, the babysitting task is still in progress; keep streaming/consuming watcher output instead of ending the turn.

## Polling Cadence
Use adaptive polling and continue monitoring even after CI turns green:

- While CI is not green (pending/running/queued or failing): poll every 1 minute.
- After CI turns green: start at every 1 minute, then back off exponentially when there is no change (for example 1m, 2m, 4m, 8m, 16m, 32m), capping at every 1 hour.
- Reset the green-state polling interval back to 1 minute whenever anything changes (new commit/SHA, check status changes, new review comments, mergeability changes, review decision changes).
- If CI stops being green again (new commit, rerun, or regression): return to 1-minute polling.
- If any poll shows the PR is merged or otherwise closed: stop polling immediately and report the terminal state.

## Stop Conditions (Strict)
Stop only when one of the following is true:

- PR merged or closed (stop as soon as a poll/snapshot confirms this).
- PR is ready to merge: CI succeeded, no surfaced unaddressed review comments, no unresolved review threads, and no merge conflict risk.
- A PR is not ready while `review_signal.status == "in_review"` (for example when the PR has an `eyes` reaction from `chatgpt-codex-connector[bot]`).
- A PR is not ready while `review_signal.status == "awaiting_review"` (for example when GitHub still shows Copilot as a requested trusted reviewer and no review has landed yet).
- A separate approval/thumbs-up signal is not required, but any GitHub-reported merge blocking state (for example `BLOCKED`) still means the PR is not ready.
- User intervention is required and Codex cannot safely proceed alone.

Keep polling when:

- `actions` contains only `idle` but checks are still pending.
- CI is still running/queued.
- Review state is quiet but CI is not terminal.
- CI is green but mergeability is unknown/pending.
- GitHub is still showing Codex `eyes` / `review_signal.status == "in_review"`.
- GitHub is still waiting on a requested trusted AI reviewer / `review_signal.status == "awaiting_review"`.
- CI is green and mergeable, but the PR is still open and you are waiting for possible new review comments or merge-conflict changes per the green-state cadence.

## Output Expectations
Provide concise progress updates while monitoring and a final summary that includes:

- During long unchanged monitoring periods, avoid emitting a full update on every poll; summarize only status changes plus occasional heartbeat updates.
- Treat push confirmations, intermediate CI snapshots, and review-action updates as progress updates only; do not emit the final summary or end the babysitting session unless a strict stop condition is met.
- A user request to "monitor" is not satisfied by a couple of sample polls; remain in the loop until a strict stop condition or an explicit user interruption.
- A review-fix commit + push is not a completion event; immediately resume live monitoring (`--watch`) in the same turn and continue reporting progress updates.
- When CI first transitions to all green for the current SHA, emit a one-time celebratory progress update (do not repeat it on every green poll). Preferred style: `🚀 CI is all green! 33/33 passed. Still on watch for new review feedback.`
- Do not send the final summary while a watcher terminal is still running unless the watcher has emitted/confirmed a strict stop condition; otherwise continue with progress updates.

- Final PR SHA
- CI status summary
- Mergeability / conflict status
- Fixes pushed
- Flaky retry cycles used
- Remaining unresolved failures or review comments

## References

- Heuristics and decision tree: `.codex/skills/babysit-pr/references/heuristics.md`
- GitHub CLI/API details used by the watcher: `.codex/skills/babysit-pr/references/github-api-notes.md`
