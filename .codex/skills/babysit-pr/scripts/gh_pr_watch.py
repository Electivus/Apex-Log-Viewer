#!/usr/bin/env python3
"""Watch GitHub PR CI and review activity for PR babysitting workflows."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

FAILED_RUN_CONCLUSIONS = {
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
    "stale",
}
PENDING_CHECK_STATES = {
    "QUEUED",
    "IN_PROGRESS",
    "PENDING",
    "WAITING",
    "REQUESTED",
}
REVIEW_BOT_LOGINS = {
    "copilot-pull-request-reviewer",
}
REVIEW_BOT_LOGIN_KEYWORDS = {
    "codex",
}
READY_REACTION_CONTENT = "+1"
TRUSTED_AUTHOR_ASSOCIATIONS = {
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
}
MERGE_BLOCKING_REVIEW_DECISIONS = {
    "REVIEW_REQUIRED",
    "CHANGES_REQUESTED",
}
NON_BLOCKING_REVIEW_STATES = {
    "APPROVED",
    "DISMISSED",
}
MERGE_CONFLICT_OR_BLOCKING_STATES = {
    "BLOCKED",
    "DIRTY",
    "DRAFT",
    "UNKNOWN",
}
GREEN_STATE_MAX_POLL_SECONDS = 60 * 60


class GhCommandError(RuntimeError):
    pass


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Normalize PR/CI/review state for PR babysitting and optionally "
            "trigger flaky reruns."
        )
    )
    parser.add_argument("--pr", default="auto", help="auto, PR number, or PR URL")
    parser.add_argument("--repo", help="Optional OWNER/REPO override")
    parser.add_argument("--poll-seconds", type=int, default=30, help="Watch poll interval")
    parser.add_argument(
        "--max-flaky-retries",
        type=int,
        default=3,
        help="Max rerun cycles per head SHA before stop recommendation",
    )
    parser.add_argument("--state-file", help="Path to state JSON file")
    parser.add_argument("--once", action="store_true", help="Emit one snapshot and exit")
    parser.add_argument("--watch", action="store_true", help="Continuously emit JSONL snapshots")
    parser.add_argument(
        "--retry-failed-now",
        action="store_true",
        help="Rerun failed jobs for current failed workflow runs when policy allows",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable output (default behavior for --once and --retry-failed-now)",
    )
    args = parser.parse_args()

    if args.poll_seconds <= 0:
        parser.error("--poll-seconds must be > 0")
    if args.max_flaky_retries < 0:
        parser.error("--max-flaky-retries must be >= 0")
    if args.watch and args.retry_failed_now:
        parser.error("--watch cannot be combined with --retry-failed-now")
    if not args.once and not args.watch and not args.retry_failed_now:
        args.once = True
    return args


def _format_gh_error(cmd, err):
    stdout = (err.stdout or "").strip()
    stderr = (err.stderr or "").strip()
    parts = [f"GitHub CLI command failed: {' '.join(cmd)}"]
    if stdout:
        parts.append(f"stdout: {stdout}")
    if stderr:
        parts.append(f"stderr: {stderr}")
    return "\n".join(parts)


def gh_text(args, repo=None):
    cmd = ["gh"]
    # `gh api` does not accept `-R/--repo` on all gh versions. The watcher's
    # API calls use explicit endpoints (e.g. repos/{owner}/{repo}/...), so the
    # repo flag is unnecessary there.
    if repo and (not args or args[0] != "api"):
        cmd.extend(["-R", repo])
    cmd.extend(args)
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError as err:
        raise GhCommandError("`gh` command not found") from err
    except subprocess.CalledProcessError as err:
        raise GhCommandError(_format_gh_error(cmd, err)) from err
    return proc.stdout


def gh_json(args, repo=None):
    raw = gh_text(args, repo=repo).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        raise GhCommandError(f"Failed to parse JSON from gh output for {' '.join(args)}") from err


def parse_pr_spec(pr_spec):
    if pr_spec == "auto":
        return {"mode": "auto", "value": None}
    if re.fullmatch(r"\d+", pr_spec):
        return {"mode": "number", "value": pr_spec}
    parsed = urlparse(pr_spec)
    if parsed.scheme and parsed.netloc and "/pull/" in parsed.path:
        return {"mode": "url", "value": pr_spec}
    raise ValueError("--pr must be 'auto', a PR number, or a PR URL")


def pr_view_fields():
    return (
        "number,url,state,mergedAt,closedAt,headRefName,headRefOid,"
        "headRepository,headRepositoryOwner,mergeable,mergeStateStatus,reviewDecision"
    )


def checks_fields():
    return "name,state,bucket,link,workflow,event,startedAt,completedAt"


def resolve_pr(pr_spec, repo_override=None):
    parsed = parse_pr_spec(pr_spec)
    cmd = ["pr", "view"]
    if parsed["value"] is not None:
        cmd.append(parsed["value"])
    cmd.extend(["--json", pr_view_fields()])
    data = gh_json(cmd, repo=repo_override)
    if not isinstance(data, dict):
        raise GhCommandError("Unexpected PR payload from `gh pr view`")

    pr_url = str(data.get("url") or "")
    repo = (
        repo_override
        or extract_repo_from_pr_url(pr_url)
        or extract_repo_from_pr_view(data)
    )
    if not repo:
        raise GhCommandError("Unable to determine OWNER/REPO for the PR")

    state = str(data.get("state") or "")
    merged = bool(data.get("mergedAt"))
    closed = bool(data.get("closedAt")) or state.upper() == "CLOSED"

    return {
        "number": int(data["number"]),
        "url": pr_url,
        "repo": repo,
        "head_sha": str(data.get("headRefOid") or ""),
        "head_branch": str(data.get("headRefName") or ""),
        "state": state,
        "merged": merged,
        "closed": closed,
        "mergeable": str(data.get("mergeable") or ""),
        "merge_state_status": str(data.get("mergeStateStatus") or ""),
        "review_decision": str(data.get("reviewDecision") or ""),
    }


def extract_repo_from_pr_view(data):
    head_repo = data.get("headRepository")
    head_owner = data.get("headRepositoryOwner")
    owner = None
    name = None
    if isinstance(head_owner, dict):
        owner = head_owner.get("login") or head_owner.get("name")
    elif isinstance(head_owner, str):
        owner = head_owner
    if isinstance(head_repo, dict):
        name = head_repo.get("name")
        repo_owner = head_repo.get("owner")
        if not owner and isinstance(repo_owner, dict):
            owner = repo_owner.get("login") or repo_owner.get("name")
    elif isinstance(head_repo, str):
        name = head_repo
    if owner and name:
        return f"{owner}/{name}"
    return None
def extract_repo_from_pr_url(pr_url):
    parsed = urlparse(pr_url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 4 and parts[2] == "pull":
        return f"{parts[0]}/{parts[1]}"
    return None


def load_state(path):
    if path.exists():
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as err:
            raise RuntimeError(f"State file is not valid JSON: {path}") from err
        if not isinstance(data, dict):
            raise RuntimeError(f"State file must contain an object: {path}")
        return data, False
    return {
        "pr": {},
        "started_at": None,
        "last_seen_head_sha": None,
        "pending_non_thread_feedback_by_sha": {},
        "retries_by_sha": {},
        "seen_issue_comment_ids": [],
        "seen_review_comment_ids": [],
        "seen_review_ids": [],
        "last_snapshot_at": None,
    }, True


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, indent=2, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp_file:
            tmp_file.write(payload)
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def default_state_file_for(pr):
    repo_slug = pr["repo"].replace("/", "-")
    return Path(tempfile.gettempdir()) / f"codex-babysit-pr-{repo_slug}-pr{pr['number']}.json"


def get_pr_checks(pr_spec, repo):
    parsed = parse_pr_spec(pr_spec)
    cmd = ["pr", "checks"]
    if parsed["value"] is not None:
        cmd.append(parsed["value"])
    cmd.extend(["--json", checks_fields()])
    data = gh_json(cmd, repo=repo)
    if data is None:
        return []
    if not isinstance(data, list):
        raise GhCommandError("Unexpected payload from `gh pr checks`")
    return data


def is_pending_check(check):
    bucket = str(check.get("bucket") or "").lower()
    state = str(check.get("state") or "").upper()
    return bucket == "pending" or state in PENDING_CHECK_STATES


def summarize_checks(checks):
    pending_count = 0
    failed_count = 0
    passed_count = 0
    for check in checks:
        bucket = str(check.get("bucket") or "").lower()
        if is_pending_check(check):
            pending_count += 1
        if bucket == "fail":
            failed_count += 1
        if bucket == "pass":
            passed_count += 1
    return {
        "pending_count": pending_count,
        "failed_count": failed_count,
        "passed_count": passed_count,
        "all_terminal": pending_count == 0,
    }


def failed_pr_check_keys(checks):
    keys = set()
    for check in checks:
        if not isinstance(check, dict):
            continue
        bucket = str(check.get("bucket") or "").lower()
        if bucket != "fail":
            continue
        workflow_name = str(check.get("workflow") or check.get("name") or "")
        event = str(check.get("event") or "")
        keys.add((workflow_name, event))
    return keys


def get_workflow_runs_for_sha(repo, head_sha):
    endpoint = f"repos/{repo}/actions/runs"
    data = gh_json(
        ["api", endpoint, "-X", "GET", "-f", f"head_sha={head_sha}", "-f", "per_page=100"],
        repo=repo,
    )
    if not isinstance(data, dict):
        raise GhCommandError("Unexpected payload from actions runs API")
    runs = data.get("workflow_runs") or []
    if not isinstance(runs, list):
        raise GhCommandError("Expected `workflow_runs` to be a list")
    return runs


def workflow_run_key(run):
    workflow_id = run.get("workflow_id")
    key_parts = [f"event:{str(run.get('event') or '')}"]
    if workflow_id not in (None, ""):
        key_parts.insert(0, f"workflow:{workflow_id}")
        return "|".join(key_parts)
    key_parts.insert(0, f"name:{str(run.get('name') or run.get('display_title') or '')}")
    return "|".join(key_parts)


def workflow_run_sort_key(run):
    run_attempt = run.get("run_attempt")
    run_id = run.get("id")
    try:
        run_attempt = int(run_attempt)
    except (TypeError, ValueError):
        run_attempt = 0
    try:
        run_id = int(run_id)
    except (TypeError, ValueError):
        run_id = 0
    return (
        run_attempt,
        str(run.get("created_at") or ""),
        str(run.get("updated_at") or ""),
        run_id,
    )


def failed_runs_from_workflow_runs(runs, head_sha, failed_check_keys=None):
    latest_runs_by_key = {}
    failed_runs = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        if str(run.get("head_sha") or "") != head_sha:
            continue
        run_key = workflow_run_key(run)
        existing = latest_runs_by_key.get(run_key)
        if existing is None or workflow_run_sort_key(run) > workflow_run_sort_key(existing):
            latest_runs_by_key[run_key] = run

    for run in latest_runs_by_key.values():
        conclusion = str(run.get("conclusion") or "")
        if conclusion not in FAILED_RUN_CONCLUSIONS:
            continue
        workflow_name = str(run.get("name") or run.get("display_title") or "")
        event = str(run.get("event") or "")
        if failed_check_keys and (workflow_name, event) not in failed_check_keys:
            continue
        failed_runs.append(
            {
                "run_id": run.get("id"),
                "workflow_name": workflow_name,
                "event": event,
                "run_attempt": run.get("run_attempt"),
                "status": str(run.get("status") or ""),
                "conclusion": conclusion,
                "html_url": str(run.get("html_url") or ""),
            }
        )
    failed_runs.sort(key=lambda item: (str(item.get("workflow_name") or ""), str(item.get("run_id") or "")))
    return failed_runs


def get_authenticated_login():
    data = gh_json(["api", "user"])
    if not isinstance(data, dict) or not data.get("login"):
        raise GhCommandError("Unable to determine authenticated GitHub login from `gh api user`")
    return str(data["login"])


def comment_endpoints(repo, pr_number):
    return {
        "issue_comment": f"repos/{repo}/issues/{pr_number}/comments",
        "review_comment": f"repos/{repo}/pulls/{pr_number}/comments",
        "review": f"repos/{repo}/pulls/{pr_number}/reviews",
    }


def reaction_endpoint(repo, pr_number):
    return f"repos/{repo}/issues/{pr_number}/reactions"


def gh_api_list_paginated(endpoint, repo=None, per_page=100):
    items = []
    page = 1
    while True:
        sep = "&" if "?" in endpoint else "?"
        page_endpoint = f"{endpoint}{sep}per_page={per_page}&page={page}"
        payload = gh_json(["api", page_endpoint], repo=repo)
        if payload is None:
            break
        if not isinstance(payload, list):
            raise GhCommandError(f"Unexpected paginated payload from gh api {endpoint}")
        items.extend(payload)
        if len(payload) < per_page:
            break
        page += 1
    return items


def graphql_json(query, variables=None):
    cmd = ["api", "graphql", "-f", f"query={query}"]
    for key, value in (variables or {}).items():
        cmd.extend(["-F", f"{key}={value}"])
    data = gh_json(cmd)
    if not isinstance(data, dict):
        raise GhCommandError("Unexpected payload from `gh api graphql`")
    return data


def normalize_issue_comments(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "kind": "issue_comment",
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "author_association": str(item.get("author_association") or ""),
                "created_at": str(item.get("created_at") or ""),
                "body": str(item.get("body") or ""),
                "path": None,
                "line": None,
                "url": str(item.get("html_url") or ""),
            }
        )
    return out


def normalize_review_comments(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        line = item.get("line")
        if line is None:
            line = item.get("original_line")
        out.append(
            {
                "kind": "review_comment",
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "author_association": str(item.get("author_association") or ""),
                "created_at": str(item.get("created_at") or ""),
                "body": str(item.get("body") or ""),
                "path": item.get("path"),
                "line": line,
                "url": str(item.get("html_url") or ""),
            }
        )
    return out


def normalize_reviews(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "kind": "review",
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "author_association": str(item.get("author_association") or ""),
                "created_at": str(item.get("submitted_at") or item.get("created_at") or ""),
                "body": str(item.get("body") or ""),
                "review_state": str(item.get("state") or ""),
                "path": None,
                "line": None,
                "url": str(item.get("html_url") or ""),
            }
        )
    return out


def normalize_reactions(items):
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "id": str(item.get("id") or ""),
                "author": extract_login(item.get("user")),
                "content": str(item.get("content") or ""),
            }
        )
    return out


def extract_login(user_obj):
    if isinstance(user_obj, dict):
        return str(user_obj.get("login") or "")
    return ""


def normalize_review_bot_login(login):
    lower_login = str(login or "").lower()
    if lower_login.endswith("[bot]"):
        return lower_login[: -len("[bot]")]
    return lower_login


def is_bot_login(login):
    lower_login = str(login or "").lower()
    canonical_login = normalize_review_bot_login(lower_login)
    return bool(lower_login) and (
        lower_login.endswith("[bot]")
        or canonical_login in REVIEW_BOT_LOGINS
    )


def is_actionable_review_bot_login(login):
    if not is_bot_login(login):
        return False
    lower_login = normalize_review_bot_login(login)
    return (
        lower_login in REVIEW_BOT_LOGINS
        or any(keyword in lower_login for keyword in REVIEW_BOT_LOGIN_KEYWORDS)
    )


def is_trusted_human_review_author(item, authenticated_login):
    author = str(item.get("author") or "")
    if not author:
        return False
    if authenticated_login and author == authenticated_login:
        return True
    association = str(item.get("author_association") or "").upper()
    return association in TRUSTED_AUTHOR_ASSOCIATIONS


def is_authenticated_operator_item(item, authenticated_login):
    if not authenticated_login or not isinstance(item, dict):
        return False
    return str(item.get("author") or "") == authenticated_login


def is_generic_codex_summary_review(item):
    if not isinstance(item, dict):
        return False
    if str(item.get("kind") or "") != "review":
        return False
    author = str(item.get("author") or "")
    if not is_actionable_review_bot_login(author):
        return False
    body = str(item.get("body") or "").lower()
    return (
        "here are some automated review suggestions for this pull request" in body
        or "about codex in github" in body
        or (
            "## pull request overview" in body
            and "### reviewed changes" in body
            and "copilot reviewed" in body
            and "changed files in this pull request" in body
        )
    )


def is_non_blocking_review_item(item):
    if not isinstance(item, dict):
        return False
    if str(item.get("kind") or "") != "review":
        return False
    if is_generic_codex_summary_review(item):
        return True
    review_state = str(item.get("review_state") or "").upper()
    return review_state in NON_BLOCKING_REVIEW_STATES


def actionable_new_review_items(items):
    actionable_items = []
    for item in items or []:
        if is_non_blocking_review_item(item):
            continue
        actionable_items.append(item)
    return actionable_items


def is_trusted_ready_reaction_author(author, repo, authenticated_login, trust_cache=None):
    author = str(author or "")
    if not author:
        return False
    if authenticated_login and author == authenticated_login:
        return True
    cache = trust_cache if isinstance(trust_cache, dict) else {}
    cached = cache.get(author)
    if cached is not None:
        return cached
    try:
        payload = gh_json(["api", f"repos/{repo}/collaborators/{author}/permission"])
    except GhCommandError:
        cache[author] = False
        return False
    trusted = isinstance(payload, dict) and bool(payload.get("permission") or payload.get("role_name"))
    cache[author] = trusted
    return trusted


def fetch_new_review_items(pr, state, fresh_state, authenticated_login=None):
    repo = pr["repo"]
    pr_number = pr["number"]
    endpoints = comment_endpoints(repo, pr_number)

    issue_payload = gh_api_list_paginated(endpoints["issue_comment"], repo=repo)
    review_comment_payload = gh_api_list_paginated(endpoints["review_comment"], repo=repo)
    review_payload = gh_api_list_paginated(endpoints["review"], repo=repo)

    issue_items = normalize_issue_comments(issue_payload)
    review_comment_items = normalize_review_comments(review_comment_payload)
    review_items = normalize_reviews(review_payload)
    all_items = issue_items + review_comment_items + review_items

    seen_issue = {str(x) for x in state.get("seen_issue_comment_ids") or []}
    seen_review_comment = {str(x) for x in state.get("seen_review_comment_ids") or []}
    seen_review = {str(x) for x in state.get("seen_review_ids") or []}

    # On a brand-new state file, surface existing review activity instead of
    # silently treating it as seen. This avoids missing already-pending review
    # feedback when monitoring starts after comments were posted.

    new_items = []
    for item in all_items:
        item_id = item.get("id")
        if not item_id:
            continue
        author = item.get("author") or ""
        if not author:
            continue
        if authenticated_login and author == authenticated_login:
            continue
        if is_bot_login(author):
            if not is_actionable_review_bot_login(author):
                continue
        elif not is_trusted_human_review_author(item, authenticated_login):
            continue

        kind = item["kind"]
        if kind == "issue_comment" and item_id in seen_issue:
            continue
        if kind == "review_comment" and item_id in seen_review_comment:
            continue
        if kind == "review" and item_id in seen_review:
            continue

        new_items.append(item)
        if kind == "issue_comment":
            seen_issue.add(item_id)
        elif kind == "review_comment":
            seen_review_comment.add(item_id)
        elif kind == "review":
            seen_review.add(item_id)

    new_items.sort(key=lambda item: (item.get("created_at") or "", item.get("kind") or "", item.get("id") or ""))
    state["seen_issue_comment_ids"] = sorted(seen_issue)
    state["seen_review_comment_ids"] = sorted(seen_review_comment)
    state["seen_review_ids"] = sorted(seen_review)
    return new_items


def fetch_pr_ready_reactions(pr, authenticated_login=None):
    payload = gh_api_list_paginated(reaction_endpoint(pr["repo"], pr["number"]), repo=pr["repo"])
    reactions = normalize_reactions(payload)
    ready_reactions = []
    trust_cache = {}
    for reaction in reactions:
        if reaction.get("content") != READY_REACTION_CONTENT:
            continue
        author = reaction.get("author") or ""
        if not is_trusted_ready_reaction_author(
            author,
            pr["repo"],
            authenticated_login=authenticated_login,
            trust_cache=trust_cache,
        ):
            continue
        ready_reactions.append(
            {
                "id": reaction.get("id") or "",
                "author": author,
                "content": READY_REACTION_CONTENT,
            }
        )
    ready_reactions.sort(key=lambda item: (str(item.get("author") or ""), str(item.get("id") or "")))
    return ready_reactions


def blocking_non_thread_feedback_for_sha(state, head_sha):
    pending_by_sha = state.get("pending_non_thread_feedback_by_sha") or {}
    items = pending_by_sha.get(head_sha) or []
    if isinstance(items, list):
        return items
    return []


def set_blocking_non_thread_feedback_for_sha(state, head_sha, items):
    pending_by_sha = state.get("pending_non_thread_feedback_by_sha")
    if not isinstance(pending_by_sha, dict):
        pending_by_sha = {}
    pending_by_sha[head_sha] = items
    state["pending_non_thread_feedback_by_sha"] = pending_by_sha


def update_blocking_non_thread_feedback(state, head_sha, new_review_items, authenticated_login=None):
    tracked_items = {
        str(item.get("id") or ""): item
        for item in blocking_non_thread_feedback_for_sha(state, head_sha)
        if (
            isinstance(item, dict)
            and item.get("id")
            and not is_non_blocking_review_item(item)
            and not is_authenticated_operator_item(item, authenticated_login)
        )
    }
    for item in new_review_items:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "")
        if not item_id:
            continue
        if is_authenticated_operator_item(item, authenticated_login):
            tracked_items.pop(item_id, None)
            continue
        kind = str(item.get("kind") or "")
        if kind == "issue_comment":
            tracked_items[item_id] = item
            continue
        if kind != "review":
            continue
        author = str(item.get("author") or "")
        if is_non_blocking_review_item(item):
            tracked_items.pop(item_id, None)
            review_state = str(item.get("review_state") or "").upper()
            if review_state not in NON_BLOCKING_REVIEW_STATES:
                continue
            tracked_items = {
                tracked_id: tracked_item
                for tracked_id, tracked_item in tracked_items.items()
                if not (
                    str(tracked_item.get("kind") or "") == "review"
                    and str(tracked_item.get("author") or "") == author
                )
            }
            continue
        tracked_items[item_id] = item

    tracked_list = sorted(
        tracked_items.values(),
        key=lambda item: (str(item.get("created_at") or ""), str(item.get("kind") or ""), str(item.get("id") or "")),
    )
    set_blocking_non_thread_feedback_for_sha(state, head_sha, tracked_list)
    return tracked_list


def fetch_unresolved_review_threads(pr):
    owner, repo_name = pr["repo"].split("/", 1)
    query = """
query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          comments(first:100) {
            nodes {
              databaseId
              body
              path
              line
              createdAt
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
""".strip()
    unresolved_threads = []
    after_cursor = None
    while True:
        variables = {
            "owner": owner,
            "repo": repo_name,
            "number": pr["number"],
        }
        if after_cursor:
            variables["after"] = after_cursor
        payload = graphql_json(query, variables=variables)
        review_threads = (
            payload.get("data", {})
            .get("repository", {})
            .get("pullRequest", {})
            .get("reviewThreads", {})
        )
        nodes = review_threads.get("nodes", [])
        if not isinstance(nodes, list):
            raise GhCommandError("Expected reviewThreads.nodes to be a list")

        for thread in nodes:
            if not isinstance(thread, dict):
                continue
            if thread.get("isResolved") or thread.get("isOutdated"):
                continue
            comments = thread.get("comments", {}).get("nodes", [])
            if not isinstance(comments, list) or not comments:
                continue
            latest_comment = comments[-1]
            if not isinstance(latest_comment, dict):
                continue
            author = (latest_comment.get("author") or {}).get("login") or ""
            unresolved_threads.append(
                {
                    "author": str(author),
                    "body": str(latest_comment.get("body") or ""),
                    "created_at": str(latest_comment.get("createdAt") or ""),
                    "id": str(latest_comment.get("databaseId") or ""),
                    "kind": "unresolved_review_thread",
                    "line": latest_comment.get("line"),
                    "path": latest_comment.get("path"),
                    "url": pr["url"],
                }
            )

        page_info = review_threads.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        after_cursor = page_info.get("endCursor")
        if not after_cursor:
            break
    unresolved_threads.sort(
        key=lambda item: (str(item.get("created_at") or ""), str(item.get("path") or ""), str(item.get("id") or ""))
    )
    return unresolved_threads


def current_retry_count(state, head_sha):
    retries = state.get("retries_by_sha") or {}
    value = retries.get(head_sha, 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def set_retry_count(state, head_sha, count):
    retries = state.get("retries_by_sha")
    if not isinstance(retries, dict):
        retries = {}
    retries[head_sha] = int(count)
    state["retries_by_sha"] = retries


def unique_actions(actions):
    out = []
    seen = set()
    for action in actions:
        if action not in seen:
            out.append(action)
            seen.add(action)
    return out


def is_pr_ready_to_merge(
    pr,
    checks_summary,
    new_review_items,
    unresolved_review_threads,
    blocking_non_thread_feedback,
    ready_reactions,
):
    actionable_reviews = actionable_new_review_items(new_review_items)
    if pr["closed"] or pr["merged"]:
        return False
    if not checks_summary["all_terminal"]:
        return False
    if checks_summary["failed_count"] > 0 or checks_summary["pending_count"] > 0:
        return False
    if actionable_reviews:
        return False
    if unresolved_review_threads:
        return False
    if blocking_non_thread_feedback:
        return False
    if str(pr.get("mergeable") or "") != "MERGEABLE":
        return False
    has_ready_reaction = bool(ready_reactions)
    merge_state_status = str(pr.get("merge_state_status") or "")
    review_decision = str(pr.get("review_decision") or "")
    review_gate_blocked = review_decision in MERGE_BLOCKING_REVIEW_DECISIONS
    if merge_state_status in {"DIRTY", "DRAFT", "UNKNOWN"}:
        return False
    if merge_state_status == "BLOCKED" and not (has_ready_reaction and review_gate_blocked):
        return False
    if review_gate_blocked and not has_ready_reaction:
        return False
    return True


def recommend_actions(
    pr,
    checks_summary,
    failed_runs,
    new_review_items,
    unresolved_review_threads,
    blocking_non_thread_feedback,
    ready_reactions,
    retries_used,
    max_retries,
):
    actions = []
    actionable_reviews = actionable_new_review_items(new_review_items)
    if pr["closed"] or pr["merged"]:
        if actionable_reviews or unresolved_review_threads or blocking_non_thread_feedback:
            actions.append("process_review_comment")
        actions.append("stop_pr_closed")
        return unique_actions(actions)

    if is_pr_ready_to_merge(
        pr,
        checks_summary,
        new_review_items,
        unresolved_review_threads,
        blocking_non_thread_feedback,
        ready_reactions,
    ):
        actions.append("stop_ready_to_merge")
        return unique_actions(actions)

    if actionable_reviews or unresolved_review_threads or blocking_non_thread_feedback:
        actions.append("process_review_comment")

    has_failed_pr_checks = checks_summary["failed_count"] > 0
    if has_failed_pr_checks:
        if checks_summary["all_terminal"] and retries_used >= max_retries:
            actions.append("stop_exhausted_retries")
        else:
            actions.append("diagnose_ci_failure")
            if checks_summary["all_terminal"] and failed_runs and retries_used < max_retries:
                actions.append("retry_failed_checks")

    if not actions:
        actions.append("idle")
    return unique_actions(actions)


def collect_snapshot(args):
    pr = resolve_pr(args.pr, repo_override=args.repo)
    state_path = Path(args.state_file) if args.state_file else default_state_file_for(pr)
    state, fresh_state = load_state(state_path)

    if not state.get("started_at"):
        state["started_at"] = int(time.time())

    # `gh pr checks -R <repo>` requires an explicit PR/branch/url argument.
    # After resolving `--pr auto`, reuse the concrete PR number.
    checks = get_pr_checks(str(pr["number"]), repo=pr["repo"])
    checks_summary = summarize_checks(checks)
    workflow_runs = get_workflow_runs_for_sha(pr["repo"], pr["head_sha"])
    failed_runs = failed_runs_from_workflow_runs(
        workflow_runs,
        pr["head_sha"],
        failed_check_keys=failed_pr_check_keys(checks),
    )
    authenticated_login = get_authenticated_login()
    new_review_items = fetch_new_review_items(
        pr,
        state,
        fresh_state=fresh_state,
        authenticated_login=authenticated_login,
    )
    unresolved_review_threads = fetch_unresolved_review_threads(pr)
    blocking_non_thread_feedback = update_blocking_non_thread_feedback(
        state,
        pr["head_sha"],
        new_review_items,
        authenticated_login=authenticated_login,
    )
    ready_reactions = fetch_pr_ready_reactions(pr, authenticated_login=authenticated_login)

    retries_used = current_retry_count(state, pr["head_sha"])
    actions = recommend_actions(
        pr,
        checks_summary,
        failed_runs,
        new_review_items,
        unresolved_review_threads,
        blocking_non_thread_feedback,
        ready_reactions,
        retries_used,
        args.max_flaky_retries,
    )

    state["pr"] = {"repo": pr["repo"], "number": pr["number"]}
    state["last_seen_head_sha"] = pr["head_sha"]
    state["last_snapshot_at"] = int(time.time())
    save_state(state_path, state)

    snapshot = {
        "pr": pr,
        "checks": checks_summary,
        "failed_runs": failed_runs,
        "new_review_items": new_review_items,
        "unresolved_review_threads": unresolved_review_threads,
        "blocking_non_thread_feedback": blocking_non_thread_feedback,
        "approval_signal": {
            "has_pr_thumbs_up": bool(ready_reactions),
            "pr_thumbs_up_reactions": ready_reactions,
        },
        "actions": actions,
        "retry_state": {
            "current_sha_retries_used": retries_used,
            "max_flaky_retries": args.max_flaky_retries,
        },
    }
    return snapshot, state_path


def retry_failed_now(args):
    snapshot, state_path = collect_snapshot(args)
    pr = snapshot["pr"]
    checks_summary = snapshot["checks"]
    failed_runs = snapshot["failed_runs"]
    retries_used = snapshot["retry_state"]["current_sha_retries_used"]
    max_retries = snapshot["retry_state"]["max_flaky_retries"]

    result = {
        "snapshot": snapshot,
        "state_file": str(state_path),
        "rerun_attempted": False,
        "rerun_count": 0,
        "rerun_run_ids": [],
        "reason": None,
    }

    if pr["closed"] or pr["merged"]:
        result["reason"] = "pr_closed"
        return result
    if checks_summary["failed_count"] <= 0:
        result["reason"] = "no_failed_pr_checks"
        return result
    if not failed_runs:
        result["reason"] = "no_failed_runs"
        return result
    if not checks_summary["all_terminal"]:
        result["reason"] = "checks_still_pending"
        return result
    if retries_used >= max_retries:
        result["reason"] = "retry_budget_exhausted"
        return result

    for run in failed_runs:
        run_id = run.get("run_id")
        if run_id in (None, ""):
            continue
        gh_text(["run", "rerun", str(run_id), "--failed"], repo=pr["repo"])
        result["rerun_run_ids"].append(run_id)

    if result["rerun_run_ids"]:
        state, _ = load_state(state_path)
        new_count = current_retry_count(state, pr["head_sha"]) + 1
        set_retry_count(state, pr["head_sha"], new_count)
        state["last_snapshot_at"] = int(time.time())
        save_state(state_path, state)
        result["rerun_attempted"] = True
        result["rerun_count"] = len(result["rerun_run_ids"])
        result["reason"] = "rerun_triggered"
    else:
        result["reason"] = "failed_runs_missing_ids"

    return result


def print_json(obj):
    sys.stdout.write(json.dumps(obj, sort_keys=True) + "\n")
    sys.stdout.flush()


def print_event(event, payload):
    print_json({"event": event, "payload": payload})


def is_ci_green(snapshot):
    checks = snapshot.get("checks") or {}
    return (
        bool(checks.get("all_terminal"))
        and int(checks.get("failed_count") or 0) == 0
        and int(checks.get("pending_count") or 0) == 0
    )


def snapshot_change_key(snapshot):
    pr = snapshot.get("pr") or {}
    checks = snapshot.get("checks") or {}
    review_items = snapshot.get("new_review_items") or []
    unresolved_review_threads = snapshot.get("unresolved_review_threads") or []
    blocking_non_thread_feedback = snapshot.get("blocking_non_thread_feedback") or []
    approval_signal = snapshot.get("approval_signal") or {}
    ready_reactions = approval_signal.get("pr_thumbs_up_reactions") or []
    return (
        str(pr.get("head_sha") or ""),
        str(pr.get("state") or ""),
        str(pr.get("mergeable") or ""),
        str(pr.get("merge_state_status") or ""),
        str(pr.get("review_decision") or ""),
        int(checks.get("passed_count") or 0),
        int(checks.get("failed_count") or 0),
        int(checks.get("pending_count") or 0),
        tuple(
            (str(item.get("kind") or ""), str(item.get("id") or ""))
            for item in review_items
            if isinstance(item, dict)
        ),
        tuple(
            (str(item.get("path") or ""), str(item.get("id") or ""))
            for item in unresolved_review_threads
            if isinstance(item, dict)
        ),
        tuple(
            (str(item.get("kind") or ""), str(item.get("id") or ""))
            for item in blocking_non_thread_feedback
            if isinstance(item, dict)
        ),
        tuple(
            (str(item.get("author") or ""), str(item.get("id") or ""))
            for item in ready_reactions
            if isinstance(item, dict)
        ),
        tuple(snapshot.get("actions") or []),
    )


def run_watch(args):
    poll_seconds = args.poll_seconds
    last_change_key = None
    while True:
        snapshot, state_path = collect_snapshot(args)
        print_event(
            "snapshot",
            {
                "snapshot": snapshot,
                "state_file": str(state_path),
                "next_poll_seconds": poll_seconds,
            },
        )
        actions = set(snapshot.get("actions") or [])
        if (
            "stop_pr_closed" in actions
            or "stop_exhausted_retries" in actions
            or "stop_ready_to_merge" in actions
        ):
            print_event("stop", {"actions": snapshot.get("actions"), "pr": snapshot.get("pr")})
            return 0

        current_change_key = snapshot_change_key(snapshot)
        changed = current_change_key != last_change_key
        green = is_ci_green(snapshot)

        if not green:
            poll_seconds = args.poll_seconds
        elif changed or last_change_key is None:
            poll_seconds = args.poll_seconds
        else:
            poll_seconds = min(poll_seconds * 2, GREEN_STATE_MAX_POLL_SECONDS)

        last_change_key = current_change_key
        time.sleep(poll_seconds)


def main():
    args = parse_args()
    try:
        if args.retry_failed_now:
            print_json(retry_failed_now(args))
            return 0
        if args.watch:
            return run_watch(args)
        snapshot, state_path = collect_snapshot(args)
        snapshot["state_file"] = str(state_path)
        print_json(snapshot)
        return 0
    except (GhCommandError, RuntimeError, ValueError) as err:
        sys.stderr.write(f"gh_pr_watch.py error: {err}\n")
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("gh_pr_watch.py interrupted\n")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
