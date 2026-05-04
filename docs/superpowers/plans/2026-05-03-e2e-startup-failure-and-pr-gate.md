# E2E Startup Failure and PR Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the hidden E2E `startup_failure`, add a repository regression guard, and harden the local `babysit-pr` skill so startup-failure check suites without check runs block readiness.

**Architecture:** The repository fix is a narrow workflow pin change plus a Node workflow-contract test. The PR watcher fix lives in the standalone `babysit-pr-skill` source repo, where the watcher augments the PR `statusCheckRollup` with failed GitHub Actions check suites that have zero check runs.

**Tech Stack:** GitHub Actions YAML, Node `node:test`, Python `unittest`, GitHub CLI REST APIs, `babysit-pr` Python scripts.

---

### Task 1: Restore the allowed Azure login action pin in the E2E workflow

**Files:**
- Modify: `.github/workflows/e2e-playwright.yml`
- Modify: `scripts/cli-e2e-workflow.test.js`

- [ ] **Step 1: Write the failing workflow contract test**

Append this test to `scripts/cli-e2e-workflow.test.js`:

```js
test('real-org Playwright workflow uses the org-allowlisted Azure login pin', () => {
  const workflow = readWorkflow();
  const { step } = getWorkflowStep(workflow, 'Azure login for dedicated App Insights validation');

  assert.equal(
    step.uses,
    'azure/login@93381592711f247e165c389ebb30b596c84cdc48',
    'expected azure/login to stay pinned to the SHA currently allowed by the Electivus org action policy'
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the expected reason**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected: FAIL. The failure should show actual `azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43` and expected `azure/login@93381592711f247e165c389ebb30b596c84cdc48`.

- [ ] **Step 3: Update the workflow pin**

In `.github/workflows/e2e-playwright.yml`, change the Azure login step from:

```yaml
        uses: azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43
```

to:

```yaml
        uses: azure/login@93381592711f247e165c389ebb30b596c84cdc48
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --test scripts/cli-e2e-workflow.test.js
```

Expected: PASS for all tests in `scripts/cli-e2e-workflow.test.js`.

- [ ] **Step 5: Run the repository script suite**

Run:

```bash
npm run test:scripts
```

Expected: PASS.

- [ ] **Step 6: Commit the repository workflow fix**

Run:

```bash
git add .github/workflows/e2e-playwright.yml scripts/cli-e2e-workflow.test.js
git commit -m "fix(ci): use org-allowed azure login pin"
```

Expected: commit created on `feature/mitm-proxy-e2e-lab`.

---

### Task 2: Make `babysit-pr` detect failed check suites that have no check runs

**Files:**
- Modify in source repo: `/home/k3/git/babysit-pr-skill/scripts/gh_pr_watch.py`
- Modify in source repo: `/home/k3/git/babysit-pr-skill/tests/test_ci_diagnostics.py`
- Install target after tests: `/home/k3/.codex/skills/babysit-pr/`

- [ ] **Step 1: Use the skill-editing workflow and isolate the skill source**

Before editing the skill source, invoke `superpowers:writing-skills` and `superpowers:using-git-worktrees`.

Run:

```bash
cd /home/k3/git/babysit-pr-skill
git status --short --branch
git worktree add .worktrees/checksuite-startup-failure -b fix/checksuite-startup-failure main
cd .worktrees/checksuite-startup-failure
```

Expected: a clean worktree on branch `fix/checksuite-startup-failure`.

- [ ] **Step 2: Write the failing watcher test**

Add this test class to `/home/k3/git/babysit-pr-skill/.worktrees/checksuite-startup-failure/tests/test_ci_diagnostics.py`:

```python
class CheckSuiteStartupFailureTests(unittest.TestCase):
    def test_get_pr_checks_includes_failed_check_suite_without_check_runs(self):
        pr = {"repo": "owner/repo", "number": 770, "head_sha": "abc123"}

        with patch.object(
            gh_pr_watch.github_graphql,
            "load_pull_request_snapshot",
            return_value={
                "rollup": {
                    "contexts": {
                        "nodes": [],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    }
                }
            },
        ), patch.object(
            gh_pr_watch,
            "gh_json",
            return_value={
                "check_suites": [
                    {
                        "id": 67271460765,
                        "status": "completed",
                        "conclusion": "startup_failure",
                        "created_at": "2026-05-03T21:14:35Z",
                        "updated_at": "2026-05-03T21:14:35Z",
                        "latest_check_runs_count": 0,
                        "app": {"name": "GitHub Actions", "slug": "github-actions"},
                        "url": "https://api.github.com/repos/owner/repo/check-suites/67271460765",
                        "workflow_run": None,
                    }
                ]
            },
        ) as gh_json:
            checks = gh_pr_watch.get_pr_checks(pr)

        gh_json.assert_called_once_with(
            [
                "api",
                "repos/owner/repo/commits/abc123/check-suites",
                "-X",
                "GET",
                "-f",
                "per_page=100",
            ],
            repo="owner/repo",
        )
        self.assertEqual(
            checks["checks"],
            [
                {
                    "name": "GitHub Actions check suite 67271460765",
                    "state": "COMPLETED",
                    "bucket": "fail",
                    "link": "https://api.github.com/repos/owner/repo/check-suites/67271460765",
                    "workflow": "GitHub Actions",
                    "event": "",
                    "startedAt": "2026-05-03T21:14:35Z",
                    "completedAt": "2026-05-03T21:14:35Z",
                }
            ],
        )
        self.assertEqual(checks["failed_runs"], [])
```

- [ ] **Step 3: Run the focused skill test and verify it fails**

Run from `/home/k3/git/babysit-pr-skill/.worktrees/checksuite-startup-failure`:

```bash
python3 -m unittest tests.test_ci_diagnostics.CheckSuiteStartupFailureTests
```

Expected: FAIL because `get_pr_checks()` currently returns no check entries for check suites without check runs and does not call the check-suites REST endpoint.

- [ ] **Step 4: Add check-suite normalization helpers**

In `/home/k3/git/babysit-pr-skill/.worktrees/checksuite-startup-failure/scripts/gh_pr_watch.py`, add these helpers after `summarize_checks()` and before `failed_pr_check_keys()`:

```python
def _check_suite_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def failed_check_suites_without_check_runs(repo, head_sha):
    if not head_sha:
        return []
    data = gh_json(
        [
            "api",
            f"repos/{repo}/commits/{head_sha}/check-suites",
            "-X",
            "GET",
            "-f",
            "per_page=100",
        ],
        repo=repo,
    )
    if not isinstance(data, dict):
        raise GhCommandError("Unexpected payload from check suites API")
    suites = data.get("check_suites") or []
    if not isinstance(suites, list):
        raise GhCommandError("Expected check_suites to be a list")

    checks = []
    for suite in suites:
        if not isinstance(suite, dict):
            continue
        status = str(suite.get("status") or "").upper()
        conclusion = str(suite.get("conclusion") or "").lower()
        if status != "COMPLETED" or conclusion not in FAILED_RUN_CONCLUSIONS:
            continue
        if _check_suite_int(suite.get("latest_check_runs_count")) != 0:
            continue

        app = suite.get("app") or {}
        workflow_run = suite.get("workflow_run") or {}
        workflow_name = str(
            workflow_run.get("name")
            or workflow_run.get("workflow_name")
            or app.get("name")
            or "GitHub Actions"
        )
        suite_id = suite.get("id")
        checks.append(
            {
                "name": f"{workflow_name} check suite {suite_id}" if suite_id else f"{workflow_name} check suite",
                "state": status,
                "bucket": "fail",
                "link": str(workflow_run.get("html_url") or workflow_run.get("url") or suite.get("url") or ""),
                "workflow": workflow_name,
                "event": str(workflow_run.get("event") or ""),
                "startedAt": str(suite.get("created_at") or ""),
                "completedAt": str(suite.get("updated_at") or ""),
            }
        )
    checks.sort(key=lambda item: (str(item.get("workflow") or ""), str(item.get("name") or "")))
    return checks
```

- [ ] **Step 5: Merge check-suite failures into PR checks**

Replace `get_pr_checks()` in `/home/k3/git/babysit-pr-skill/.worktrees/checksuite-startup-failure/scripts/gh_pr_watch.py` with:

```python
def get_pr_checks(pr):
    snapshot = github_graphql.load_pull_request_snapshot(pr["repo"], pr["number"])
    normalized = github_graphql.normalize_status_check_rollup(snapshot.get("rollup"))
    suite_checks = failed_check_suites_without_check_runs(pr["repo"], pr.get("head_sha") or "")
    if suite_checks:
        normalized["checks"].extend(suite_checks)
    return normalized
```

- [ ] **Step 6: Run the focused skill test and verify it passes**

Run:

```bash
python3 -m unittest tests.test_ci_diagnostics.CheckSuiteStartupFailureTests
```

Expected: PASS.

- [ ] **Step 7: Run the full skill test suite**

Run:

```bash
python3 -m unittest discover -s tests -p "test_*.py"
```

Expected: PASS.

- [ ] **Step 8: Commit the skill source change**

Run:

```bash
git add scripts/gh_pr_watch.py tests/test_ci_diagnostics.py
git commit -m "fix: detect startup failure check suites"
```

Expected: commit created on `fix/checksuite-startup-failure` in the `babysit-pr-skill` worktree.

- [ ] **Step 9: Install the updated skill into Codex**

Run:

```bash
./scripts/install_local.sh
```

Expected: the updated skill is copied into `/home/k3/.codex/skills/babysit-pr/`.

- [ ] **Step 10: Verify the installed watcher reports PR #770 as blocked while the hidden suite remains on the remote head**

Run from `/home/k3/.codex/skills/babysit-pr` before pushing the repository workflow fix, if the PR remote head is still the SHA with the hidden startup failure:

```bash
python3 scripts/gh_pr_watch.py --repo Electivus/Apex-Log-Viewer --pr 770 --once
```

Expected: the output includes a failed check named `GitHub Actions check suite 67271460765` or another GitHub Actions check-suite failure for the current PR head, and the watcher does not emit a ready terminal state.

---

### Task 3: Push, rerun the E2E workflow, and restore PR readiness only after verification

**Files:**
- No additional source files expected.

- [ ] **Step 1: Push the repository branch**

Run from `/home/k3/git/Apex-Log-Viewer/.worktrees/mitm-proxy-e2e-lab`:

```bash
git push origin feature/mitm-proxy-e2e-lab
```

Expected: PR #770 receives a new head SHA and GitHub creates a new `pull_request` E2E workflow run.

- [ ] **Step 2: Confirm the E2E workflow no longer startup-fails**

Run:

```bash
gh run list --repo Electivus/Apex-Log-Viewer --branch feature/mitm-proxy-e2e-lab --workflow e2e-playwright.yml --limit 5 --json databaseId,status,conclusion,event,headSha,createdAt,url | jq -r '.[] | [.databaseId,.status,.conclusion,.event,.headSha[0:8],.createdAt,.url] | @tsv'
```

Expected: the newest run for the pushed head SHA is not `startup_failure`. A running or queued run is acceptable at this step because it proves GitHub created jobs.

- [ ] **Step 3: Inspect jobs for the newest E2E run**

```bash
run_id="$(gh run list --repo Electivus/Apex-Log-Viewer --branch feature/mitm-proxy-e2e-lab --workflow e2e-playwright.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "${run_id}" --repo Electivus/Apex-Log-Viewer --json status,conclusion,jobs,url | jq .
```

Expected: `jobs` is non-empty. If the run is still in progress, keep monitoring. If it completes with job failures, diagnose those failures with `superpowers:systematic-debugging`.

- [ ] **Step 4: Re-run the installed `babysit-pr` watcher**

Run from `/home/k3/.codex/skills/babysit-pr`:

```bash
python3 scripts/gh_pr_watch.py --repo Electivus/Apex-Log-Viewer --pr 770 --once
```

Expected: the watcher reflects the current PR head. It must not hide failed checks. If checks pass but review is still required or the PR remains draft, it should stop at human-approval/draft state rather than claiming merged.

- [ ] **Step 5: Leave PR #770 draft unless all E2E and visible/hidden checks are green**

If E2E is green and the watcher reports no failed or pending checks, decide whether to mark the PR ready for review. If E2E is pending or failed, keep the PR as draft and comment with the current blocker.

- [ ] **Step 6: Add an operational note to the final report**

Report that the active repo ruleset does not require status checks. The durable GitHub-side merge block requires adding required status checks to the ruleset; code changes alone cannot enforce that setting.
