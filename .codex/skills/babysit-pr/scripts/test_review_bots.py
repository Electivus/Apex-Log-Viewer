import pathlib
import sys
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import gh_pr_codex_feedback
import gh_pr_watch


class ActionableReviewBotTests(unittest.TestCase):
    def test_exact_copilot_reviewer_is_actionable(self):
        self.assertTrue(gh_pr_watch.is_actionable_review_bot_login("copilot-pull-request-reviewer"))

    def test_other_copilot_logins_are_not_actionable(self):
        self.assertFalse(gh_pr_watch.is_actionable_review_bot_login("copilot-helper[bot]"))

    def test_non_bot_login_with_keyword_is_not_actionable(self):
        self.assertFalse(gh_pr_watch.is_actionable_review_bot_login("codex-reviewer"))
        self.assertFalse(gh_pr_codex_feedback.is_actionable_review_bot_login("codex-reviewer"))


class FeedbackListingTests(unittest.TestCase):
    def test_feedback_listing_includes_exact_copilot_reviewer_only(self):
        pr = {
            "number": 632,
            "repo": "Electivus/Apex-Log-Viewer",
            "head_sha": "abc123",
            "url": "https://github.com/Electivus/Apex-Log-Viewer/pull/632",
        }

        reviews_payload = [
            {
                "user": {"login": "copilot-pull-request-reviewer"},
                "commit_id": "abc123",
                "node_id": "PRR_kwDO1",
                "body": "Copilot top-level review",
                "submitted_at": "2026-03-22T23:00:00Z",
                "html_url": "https://github.com/Electivus/Apex-Log-Viewer/pull/632#pullrequestreview-1",
                "state": "COMMENTED",
            },
            {
                "user": {"login": "copilot-helper[bot]"},
                "commit_id": "abc123",
                "node_id": "PRR_kwDO2",
                "body": "Should not be included",
                "submitted_at": "2026-03-22T23:01:00Z",
                "html_url": "https://github.com/Electivus/Apex-Log-Viewer/pull/632#pullrequestreview-2",
                "state": "COMMENTED",
            },
        ]

        threads_payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "nodes": [
                                {
                                    "id": "PRRT_kwDOthread1",
                                    "isResolved": False,
                                    "isOutdated": False,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "id": "PRRC_kwDOignore",
                                                "databaseId": 1001,
                                                "body": "Ignored comment",
                                                "path": "file.py",
                                                "line": 10,
                                                "url": "https://example.com/ignore",
                                                "createdAt": "2026-03-22T22:59:00Z",
                                                "author": {"login": "some-other-bot"},
                                            },
                                            {
                                                "id": "PRRC_kwDOcopilot",
                                                "databaseId": 1002,
                                                "body": "Copilot thread comment",
                                                "path": "file.py",
                                                "line": 11,
                                                "url": "https://example.com/copilot",
                                                "createdAt": "2026-03-22T23:02:00Z",
                                                "author": {"login": "copilot-pull-request-reviewer"},
                                            },
                                        ]
                                    },
                                },
                                {
                                    "id": "PRRT_kwDOthread2",
                                    "isResolved": False,
                                    "isOutdated": False,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "id": "PRRC_kwDOothercopilot",
                                                "databaseId": 1003,
                                                "body": "Should stay excluded",
                                                "path": "file.py",
                                                "line": 12,
                                                "url": "https://example.com/other",
                                                "createdAt": "2026-03-22T23:03:00Z",
                                                "author": {"login": "copilot-helper[bot]"},
                                            }
                                        ]
                                    },
                                },
                            ],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            }
        }

        with patch.object(
            gh_pr_codex_feedback,
            "gh_api_list_paginated",
            return_value=reviews_payload,
        ), patch.object(
            gh_pr_codex_feedback,
            "graphql_json",
            return_value=threads_payload,
        ):
            items = gh_pr_codex_feedback.list_feedback_items(pr)

        self.assertEqual(
            [item["author"] for item in items],
            [
                "copilot-pull-request-reviewer",
                "copilot-pull-request-reviewer",
            ],
        )
        self.assertEqual([item["kind"] for item in items], ["review", "thread"])
        self.assertEqual(items[1]["database_id"], "1002")


if __name__ == "__main__":
    unittest.main()
