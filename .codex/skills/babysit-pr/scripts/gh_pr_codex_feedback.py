#!/usr/bin/env python3
"""List, acknowledge, reject, or capture actionable review bot feedback on a GitHub PR."""

import argparse
import json
import re
import sys

from gh_pr_watch import GhCommandError, gh_api_list_paginated, gh_json, graphql_json, resolve_pr

ACTIONABLE_REVIEW_BOT_LOGINS = {
    "copilot-pull-request-reviewer",
}
ACTIONABLE_REVIEW_BOT_LOGIN_KEYWORDS = {
    "codex",
}
REACTION_CONTENTS = {
    "ack": "THUMBS_UP",
    "reject": "THUMBS_DOWN",
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="List actionable review bot feedback and optionally react/resolve it."
    )
    parser.add_argument("--pr", default="auto", help="auto, PR number, or PR URL")
    parser.add_argument("--repo", help="Optional OWNER/REPO override")
    parser.add_argument(
        "--include-older-reviews",
        action="store_true",
        help="Include top-level actionable review bot reviews from older SHAs on the same PR",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show intended mutations without applying them",
    )
    parser.add_argument(
        "--no-resolve",
        action="store_true",
        help="Do not resolve threads when reacting to thread items",
    )
    parser.add_argument(
        "--no-react",
        action="store_true",
        help="Do not react to source feedback when creating follow-up issues",
    )
    parser.add_argument(
        "--issue-label",
        action="append",
        default=[],
        help="Label to apply to follow-up issues; may be repeated",
    )
    parser.add_argument(
        "--issue-title-prefix",
        default="Follow-up",
        help="Prefix to use when creating follow-up issue titles",
    )
    parser.add_argument(
        "--reply-body",
        help=(
            "Optional reply to post on thread items before resolving them. Supports "
            "placeholders such as {issue_url}, {issue_number}, {pr_url}, {pr_number}, "
            "{item_id}, {path}, and {line}."
        ),
    )
    parser.add_argument(
        "--no-reply",
        action="store_true",
        help="Do not post a reply on review threads before resolving them",
    )

    action_group = parser.add_mutually_exclusive_group(required=True)
    action_group.add_argument(
        "--list",
        action="store_true",
        help="List actionable review bot feedback items",
    )
    action_group.add_argument(
        "--ack-all",
        action="store_true",
        help="React with 👍 to all listed items and resolve thread items",
    )
    action_group.add_argument(
        "--reject-all",
        action="store_true",
        help="React with 👎 to all listed items and leave thread state unchanged unless --no-resolve is omitted",
    )
    action_group.add_argument(
        "--ack",
        nargs="+",
        metavar="ITEM_ID",
        help="React with 👍 to specific listed item IDs",
    )
    action_group.add_argument(
        "--reject",
        nargs="+",
        metavar="ITEM_ID",
        help="React with 👎 to specific listed item IDs",
    )
    action_group.add_argument(
        "--follow-up-all",
        action="store_true",
        help=(
            "Create follow-up GitHub issues for all listed items, then react with 👍 "
            "and resolve thread items unless disabled"
        ),
    )
    action_group.add_argument(
        "--follow-up",
        nargs="+",
        metavar="ITEM_ID",
        help=(
            "Create follow-up GitHub issues for specific listed item IDs, then react "
            "with 👍 and resolve thread items unless disabled"
        ),
    )
    return parser.parse_args()


def print_json(payload):
    sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")


def is_actionable_review_bot_login(login):
    lower_login = str(login or "").lower()
    return (
        lower_login in ACTIONABLE_REVIEW_BOT_LOGINS
        or any(keyword in lower_login for keyword in ACTIONABLE_REVIEW_BOT_LOGIN_KEYWORDS)
    )


def summarize_body(body, limit=160):
    text = " ".join(str(body or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def quote_markdown(text):
    lines = str(text or "").splitlines() or [""]
    return "\n".join(f"> {line}" if line else ">" for line in lines)


def plain_text_excerpt(text, limit=90):
    cleaned = str(text or "")
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", cleaned)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    cleaned = cleaned.replace("`", "")
    cleaned = cleaned.replace("*", "")
    cleaned = re.sub(r"Useful\?\s*React with.*$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        return "Investigate actionable review bot feedback"
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3] + "..."


def format_reply_body(template, pr, item, follow_up_issue=None):
    values = {
        "pr_number": pr["number"],
        "pr_url": pr["url"],
        "item_id": item["item_id"],
        "path": item.get("path") or "",
        "line": item.get("line") if item.get("line") is not None else "",
        "issue_number": "",
        "issue_url": "",
    }
    if isinstance(follow_up_issue, dict):
        values["issue_number"] = follow_up_issue.get("issue_number") or ""
        values["issue_url"] = follow_up_issue.get("issue_url") or ""
        if not values["issue_number"] and follow_up_issue.get("status") == "dry_run":
            values["issue_number"] = "new"
        if not values["issue_url"] and follow_up_issue.get("status") == "dry_run":
            values["issue_url"] = "(issue URL available on live run)"
    try:
        return str(template).format(**values).strip()
    except KeyError as err:
        raise GhCommandError(f"Unknown placeholder in --reply-body: {err}") from err


def fetch_actionable_reviews(pr, include_older_reviews=False):
    endpoint = f"repos/{pr['repo']}/pulls/{pr['number']}/reviews"
    payload = gh_api_list_paginated(endpoint, repo=pr["repo"])
    items = []
    for review in payload:
        if not isinstance(review, dict):
            continue
        login = ((review.get("user") or {}).get("login")) or ""
        if not is_actionable_review_bot_login(login):
            continue
        commit_id = str(review.get("commit_id") or "")
        if not include_older_reviews and commit_id and commit_id != pr["head_sha"]:
            continue
        node_id = str(review.get("node_id") or "")
        if not node_id:
            continue
        item_id = f"review:{node_id}"
        body = str(review.get("body") or "")
        items.append(
            {
                "item_id": item_id,
                "kind": "review",
                "subject_id": node_id,
                "thread_id": None,
                "author": login,
                "body": body,
                "summary": summarize_body(body),
                "commit_id": commit_id,
                "created_at": str(review.get("submitted_at") or review.get("created_at") or ""),
                "html_url": str(review.get("html_url") or ""),
                "review_state": str(review.get("state") or ""),
                "path": None,
                "line": None,
            }
        )
    items.sort(key=lambda item: (item["created_at"], item["item_id"]))
    return items


def fetch_actionable_threads(pr):
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
          id
          isResolved
          isOutdated
          comments(first:100) {
            nodes {
              id
              databaseId
              body
              path
              line
              url
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
    items = []
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
            thread_id = str(thread.get("id") or "")
            comments = thread.get("comments", {}).get("nodes", [])
            if not thread_id or not isinstance(comments, list) or not comments:
                continue
            latest_actionable_comment = None
            for comment in comments:
                if not isinstance(comment, dict):
                    continue
                login = ((comment.get("author") or {}).get("login")) or ""
                if is_actionable_review_bot_login(login):
                    latest_actionable_comment = comment
            if not isinstance(latest_actionable_comment, dict):
                continue
            login = ((latest_actionable_comment.get("author") or {}).get("login")) or ""
            subject_id = str(latest_actionable_comment.get("id") or "")
            body = str(latest_actionable_comment.get("body") or "")
            items.append(
                {
                    "item_id": f"thread:{thread_id}",
                    "kind": "thread",
                    "subject_id": subject_id,
                    "thread_id": thread_id,
                    "author": login,
                    "body": body,
                    "summary": summarize_body(body),
                    "commit_id": pr["head_sha"],
                    "created_at": str(latest_actionable_comment.get("createdAt") or ""),
                    "html_url": str(latest_actionable_comment.get("url") or pr["url"]),
                    "review_state": None,
                    "path": latest_actionable_comment.get("path"),
                    "line": latest_actionable_comment.get("line"),
                    "database_id": str(latest_actionable_comment.get("databaseId") or ""),
                }
            )
        page_info = review_threads.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        after_cursor = page_info.get("endCursor")
        if not after_cursor:
            break
    items.sort(key=lambda item: (item["created_at"], item["item_id"]))
    return items


def list_feedback_items(pr, include_older_reviews=False):
    items = fetch_actionable_threads(pr)
    items.extend(fetch_actionable_reviews(pr, include_older_reviews=include_older_reviews))
    items.sort(key=lambda item: (item["created_at"], item["kind"], item["item_id"]))
    return items


def add_reaction(subject_id, reaction_content, dry_run=False):
    if dry_run:
        return {
            "status": "dry_run",
            "subject_id": subject_id,
            "reaction": reaction_content,
        }
    mutation = """
mutation($subjectId:ID!, $content:ReactionContent!) {
  addReaction(input:{subjectId:$subjectId, content:$content}) {
    reaction {
      content
    }
    subject {
      id
    }
  }
}
""".strip()
    payload = graphql_json(
        mutation,
        variables={
            "subjectId": subject_id,
            "content": reaction_content,
        },
    )
    reaction = (
        payload.get("data", {})
        .get("addReaction", {})
        .get("reaction", {})
        .get("content")
    )
    return {
        "status": "reacted",
        "subject_id": subject_id,
        "reaction": reaction,
    }


def build_issue_title(item, title_prefix):
    summary = plain_text_excerpt(item.get("body") or item.get("summary"), limit=90)
    title = f"{title_prefix}: {summary}"
    return title[:120]


def build_issue_body(pr, item):
    details = [
        "This follow-up was captured from actionable review bot feedback that looks important but out of scope for the current PR.",
        "",
        f"- PR: #{pr['number']} ({pr['url']})",
        f"- Review item: {item['html_url']}",
        f"- Reviewer: `{item['author']}`",
        f"- Kind: `{item['kind']}`",
    ]
    if item.get("review_state"):
        details.append(f"- Review state: `{item['review_state']}`")
    if item.get("commit_id"):
        details.append(f"- Commit SHA: `{item['commit_id']}`")
    if item.get("path"):
        details.append(f"- File: `{item['path']}`")
    if item.get("line") is not None:
        details.append(f"- Line: `{item['line']}`")
    details.extend(
        [
            "",
            "Summary",
            "",
            item.get("summary") or "_No summary provided._",
            "",
            "Original feedback",
            "",
            quote_markdown(item.get("body") or "_No body provided._"),
        ]
    )
    return "\n".join(details)


def create_follow_up_issue(pr, item, title_prefix="Follow-up", labels=None, dry_run=False):
    title = build_issue_title(item, title_prefix)
    body = build_issue_body(pr, item)
    labels = [label for label in labels or [] if label]
    if dry_run:
        return {
            "status": "dry_run",
            "title": title,
            "body": body,
            "labels": labels,
        }

    args = [
        "api",
        "--method",
        "POST",
        f"repos/{pr['repo']}/issues",
        "-f",
        f"title={title}",
        "-f",
        f"body={body}",
    ]
    for label in labels:
        args.extend(["-f", f"labels[]={label}"])
    payload = gh_json(args)
    if not isinstance(payload, dict):
        raise GhCommandError("Unexpected issue payload from `gh api repos/.../issues`")
    return {
        "status": "created",
        "issue_number": payload.get("number"),
        "issue_url": str(payload.get("html_url") or ""),
        "title": str(payload.get("title") or title),
        "labels": labels,
    }


def resolve_thread(thread_id, dry_run=False):
    if dry_run:
        return {
            "status": "dry_run",
            "thread_id": thread_id,
            "resolved": True,
        }
    mutation = """
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread {
      id
      isResolved
    }
  }
}
""".strip()
    payload = graphql_json(mutation, variables={"threadId": thread_id})
    thread = payload.get("data", {}).get("resolveReviewThread", {}).get("thread", {})
    return {
        "status": "resolved",
        "thread_id": str(thread.get("id") or thread_id),
        "resolved": bool(thread.get("isResolved")),
    }


def reply_to_thread(pr, item, body, dry_run=False):
    if item.get("kind") != "thread":
        return {
            "status": "skipped",
            "reason": "item is not a thread",
        }
    comment_database_id = str(item.get("database_id") or "")
    if not comment_database_id:
        return {
            "status": "skipped",
            "reason": "thread comment database id is unavailable",
        }
    if dry_run:
        return {
            "status": "dry_run",
            "comment_database_id": comment_database_id,
            "body": body,
        }
    payload = gh_json(
        [
            "api",
            "--method",
            "POST",
            f"repos/{pr['repo']}/pulls/{pr['number']}/comments/{comment_database_id}/replies",
            "-f",
            f"body={body}",
        ]
    )
    if not isinstance(payload, dict):
        raise GhCommandError("Unexpected reply payload from `gh api pulls/.../comments/.../replies`")
    return {
        "status": "replied",
        "comment_database_id": comment_database_id,
        "reply_url": str(payload.get("html_url") or ""),
        "reply_id": payload.get("id"),
    }


def select_items(items, selected_ids=None, all_items=False):
    if all_items:
        return items
    item_by_id = {item["item_id"]: item for item in items}
    selected = []
    missing = []
    for item_id in selected_ids or []:
        item = item_by_id.get(item_id)
        if item is None:
            missing.append(item_id)
            continue
        selected.append(item)
    if missing:
        raise GhCommandError(f"Unknown item IDs: {', '.join(missing)}")
    return selected


def act_on_items(
    pr,
    items,
    reaction_key,
    dry_run=False,
    resolve_threads_enabled=True,
    reply_body_template=None,
    reply_enabled=True,
):
    reaction_content = REACTION_CONTENTS[reaction_key]
    results = []
    for item in items:
        item_result = {
            "item_id": item["item_id"],
            "kind": item["kind"],
            "html_url": item["html_url"],
        }
        if reply_enabled and reply_body_template and item["kind"] == "thread":
            reply_body = format_reply_body(reply_body_template, pr, item)
            if reply_body:
                item_result["reply"] = reply_to_thread(pr, item, reply_body, dry_run=dry_run)
        item_result["reaction"] = add_reaction(item["subject_id"], reaction_content, dry_run=dry_run)
        if item["kind"] == "thread" and resolve_threads_enabled:
            item_result["thread_resolution"] = resolve_thread(item["thread_id"], dry_run=dry_run)
        results.append(item_result)
    return results


def create_follow_up_results(
    pr,
    items,
    dry_run=False,
    resolve_threads_enabled=True,
    react_to_source=True,
    issue_labels=None,
    issue_title_prefix="Follow-up",
    reply_enabled=True,
    reply_body_template=None,
):
    results = []
    for item in items:
        follow_up_issue = create_follow_up_issue(
            pr,
            item,
            title_prefix=issue_title_prefix,
            labels=issue_labels,
            dry_run=dry_run,
        )
        item_result = {
            "item_id": item["item_id"],
            "kind": item["kind"],
            "html_url": item["html_url"],
            "follow_up_issue": follow_up_issue,
        }
        if reply_enabled and item["kind"] == "thread":
            template = reply_body_template or (
                "Captured for follow-up in #{issue_number}: {issue_url}\n\n"
                "Keeping this PR focused on its current scope."
            )
            reply_body = format_reply_body(template, pr, item, follow_up_issue=follow_up_issue)
            if reply_body:
                item_result["reply"] = reply_to_thread(pr, item, reply_body, dry_run=dry_run)
        if react_to_source:
            item_result["reaction"] = add_reaction(
                item["subject_id"],
                REACTION_CONTENTS["ack"],
                dry_run=dry_run,
            )
        if item["kind"] == "thread" and resolve_threads_enabled:
            item_result["thread_resolution"] = resolve_thread(item["thread_id"], dry_run=dry_run)
        results.append(item_result)
    return results


def main():
    args = parse_args()
    try:
        pr = resolve_pr(args.pr, repo_override=args.repo)
        items = list_feedback_items(
            pr,
            include_older_reviews=args.include_older_reviews,
        )

        if args.list:
            print_json(
                {
                    "items": items,
                    "pr": pr,
                }
            )
            return 0

        if args.ack_all:
            selected_items = select_items(items, all_items=True)
            reaction_key = "ack"
        elif args.reject_all:
            selected_items = select_items(items, all_items=True)
            reaction_key = "reject"
        elif args.ack:
            selected_items = select_items(items, selected_ids=args.ack)
            reaction_key = "ack"
        elif args.follow_up_all:
            selected_items = select_items(items, all_items=True)
            reaction_key = None
        elif args.follow_up:
            selected_items = select_items(items, selected_ids=args.follow_up)
            reaction_key = None
        else:
            selected_items = select_items(items, selected_ids=args.reject)
            reaction_key = "reject"

        if reaction_key is None:
            results = create_follow_up_results(
                pr,
                selected_items,
                dry_run=args.dry_run,
                resolve_threads_enabled=not args.no_resolve,
                react_to_source=not args.no_react,
                issue_labels=args.issue_label,
                issue_title_prefix=args.issue_title_prefix,
                reply_enabled=not args.no_reply,
                reply_body_template=args.reply_body,
            )
        else:
            results = act_on_items(
                pr,
                selected_items,
                reaction_key,
                dry_run=args.dry_run,
                resolve_threads_enabled=not args.no_resolve,
                reply_body_template=args.reply_body,
                reply_enabled=not args.no_reply,
            )
        print_json(
            {
                "pr": pr,
                "results": results,
                "selected_items": selected_items,
            }
        )
        return 0
    except (GhCommandError, RuntimeError, ValueError) as err:
        sys.stderr.write(f"gh_pr_codex_feedback.py error: {err}\n")
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("gh_pr_codex_feedback.py interrupted\n")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
