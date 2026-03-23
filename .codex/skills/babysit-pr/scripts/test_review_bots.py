import pathlib
import sys
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import gh_pr_codex_feedback
import gh_pr_review_feedback
import gh_pr_watch


class ActionableReviewBotTests(unittest.TestCase):
    def test_copilot_rest_login_alias_is_actionable(self):
        self.assertTrue(gh_pr_watch.is_actionable_review_bot_login("Copilot"))
        self.assertTrue(gh_pr_review_feedback.is_actionable_review_bot_login("Copilot"))

    def test_github_code_quality_review_bot_is_actionable(self):
        self.assertTrue(gh_pr_watch.is_actionable_review_bot_login("github-code-quality"))
        self.assertTrue(gh_pr_watch.is_actionable_review_bot_login("github-code-quality[bot]"))
        self.assertTrue(gh_pr_review_feedback.is_actionable_review_bot_login("github-code-quality"))

    def test_exact_copilot_reviewer_is_actionable(self):
        self.assertTrue(gh_pr_watch.is_actionable_review_bot_login("copilot-pull-request-reviewer"))

    def test_copilot_bot_login_variant_is_actionable(self):
        self.assertTrue(
            gh_pr_watch.is_actionable_review_bot_login("copilot-pull-request-reviewer[bot]")
        )
        self.assertTrue(
            gh_pr_codex_feedback.is_actionable_review_bot_login("copilot-pull-request-reviewer[bot]")
        )

    def test_exact_codex_connector_login_is_actionable(self):
        self.assertTrue(gh_pr_watch.is_actionable_review_bot_login("chatgpt-codex-connector"))
        self.assertTrue(gh_pr_codex_feedback.is_actionable_review_bot_login("chatgpt-codex-connector"))

    def test_other_copilot_logins_are_not_actionable(self):
        self.assertFalse(gh_pr_watch.is_actionable_review_bot_login("copilot-helper[bot]"))

    def test_non_bot_login_with_keyword_is_not_actionable(self):
        self.assertFalse(gh_pr_watch.is_actionable_review_bot_login("codex-reviewer"))
        self.assertFalse(gh_pr_codex_feedback.is_actionable_review_bot_login("codex-reviewer"))

    def test_generic_copilot_overview_review_is_non_blocking(self):
        item = {
            "kind": "review",
            "author": "copilot-pull-request-reviewer[bot]",
            "body": (
                "## Pull request overview\n\n"
                "Updates the babysit-pr watcher.\n\n"
                "### Reviewed changes\n\n"
                "Copilot reviewed 4 out of 4 changed files in this pull request and generated 2 comments."
            ),
            "review_state": "COMMENTED",
        }

        self.assertTrue(gh_pr_watch.is_non_blocking_review_item(item))


class FeedbackListingTests(unittest.TestCase):
    def test_feedback_listing_includes_github_code_quality_reviews(self):
        pr = {
            "number": 638,
            "repo": "Electivus/Apex-Log-Viewer",
            "head_sha": "def456",
            "url": "https://github.com/Electivus/Apex-Log-Viewer/pull/638",
        }

        reviews_payload = [
            {
                "user": {"login": "github-code-quality"},
                "commit_id": "def456",
                "node_id": "PRR_kwDOcodequality1",
                "body": "Code Quality review comment",
                "submitted_at": "2026-03-23T12:10:00Z",
                "html_url": "https://github.com/Electivus/Apex-Log-Viewer/pull/638#pullrequestreview-3",
                "state": "COMMENTED",
            }
        ]

        threads_payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "nodes": [],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            }
        }

        with patch.object(
            gh_pr_review_feedback,
            "gh_api_list_paginated",
            return_value=reviews_payload,
        ), patch.object(
            gh_pr_review_feedback,
            "graphql_json",
            return_value=threads_payload,
        ):
            items = gh_pr_review_feedback.list_feedback_items(pr)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["author"], "github-code-quality")
        self.assertEqual(items[0]["kind"], "review")
        self.assertEqual(items[0]["item_id"], "review:PRR_kwDOcodequality1")

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
            gh_pr_review_feedback,
            "gh_api_list_paginated",
            return_value=reviews_payload,
        ), patch.object(
            gh_pr_review_feedback,
            "graphql_json",
            return_value=threads_payload,
        ):
            items = gh_pr_review_feedback.list_feedback_items(pr)

        self.assertEqual(
            [item["author"] for item in items],
            [
                "copilot-pull-request-reviewer",
                "copilot-pull-request-reviewer",
            ],
        )
        self.assertEqual([item["kind"] for item in items], ["review", "thread"])
        self.assertEqual(items[1]["database_id"], "1002")

    def test_feedback_listing_keeps_unresolved_outdated_bot_threads_visible(self):
        pr = {
            "number": 639,
            "repo": "Electivus/Apex-Log-Viewer",
            "head_sha": "abc123",
            "url": "https://github.com/Electivus/Apex-Log-Viewer/pull/639",
        }
        reviews_payload = []
        threads_payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "nodes": [
                                {
                                    "id": "PRRT_kwDOoutdated",
                                    "isResolved": False,
                                    "isOutdated": True,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "id": "PRRC_kwDOoutdated",
                                                "databaseId": 2001,
                                                "body": "Still needs an explicit reply.",
                                                "path": "file.py",
                                                "line": 15,
                                                "url": "https://example.com/outdated",
                                                "createdAt": "2026-03-23T12:40:00Z",
                                                "author": {"login": "chatgpt-codex-connector"},
                                            }
                                        ]
                                    },
                                }
                            ],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            }
        }

        with patch.object(
            gh_pr_review_feedback,
            "gh_api_list_paginated",
            return_value=reviews_payload,
        ), patch.object(
            gh_pr_review_feedback,
            "graphql_json",
            return_value=threads_payload,
        ):
            items = gh_pr_review_feedback.list_feedback_items(pr)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], "thread")
        self.assertTrue(items[0]["is_outdated"])

    def test_fetch_new_review_items_includes_inline_copilot_rest_comment_alias(self):
        pr = {
            "number": 637,
            "repo": "Electivus/Apex-Log-Viewer",
        }
        state = {
            "seen_issue_comment_ids": [],
            "seen_review_comment_ids": [],
            "seen_review_ids": [],
        }

        def fake_paginated(endpoint, repo=None, per_page=100):
            if endpoint.endswith("/issues/637/comments"):
                return []
            if endpoint.endswith("/pulls/637/comments"):
                return [
                    {
                        "id": 2974504681,
                        "user": {"login": "Copilot"},
                        "author_association": "CONTRIBUTOR",
                        "created_at": "2026-03-23T11:39:51Z",
                        "body": "Copilot inline review comment",
                        "path": ".codex/skills/babysit-pr/SKILL.md",
                        "line": 29,
                        "html_url": "https://github.com/example/review-comment",
                    }
                ]
            if endpoint.endswith("/pulls/637/reviews"):
                return []
            raise AssertionError(f"Unexpected endpoint: {endpoint}")

        with patch.object(gh_pr_watch, "gh_api_list_paginated", side_effect=fake_paginated):
            items = gh_pr_watch.fetch_new_review_items(
                pr,
                state,
                fresh_state=False,
                authenticated_login="manoelcalixto",
            )

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], "review_comment")
        self.assertEqual(items[0]["id"], "2974504681")

    def test_fetch_unresolved_review_threads_include_supported_review_bots_only(self):
        pr = {
            "number": 638,
            "repo": "Electivus/Apex-Log-Viewer",
            "url": "https://github.com/Electivus/Apex-Log-Viewer/pull/638",
        }
        payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "nodes": [
                                {
                                    "isResolved": False,
                                    "isOutdated": False,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "databaseId": 1,
                                                "body": "Support this code-quality bot thread",
                                                "path": "a.py",
                                                "line": 10,
                                                "createdAt": "2026-03-23T12:07:12Z",
                                                "author": {"login": "github-code-quality"},
                                            }
                                        ]
                                    },
                                },
                                {
                                    "isResolved": False,
                                    "isOutdated": False,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "databaseId": 2,
                                                "body": "Copilot wants a change here",
                                                "path": "b.py",
                                                "line": 20,
                                                "createdAt": "2026-03-23T12:07:13Z",
                                                "author": {"login": "copilot-pull-request-reviewer"},
                                            }
                                        ]
                                    },
                                },
                                {
                                    "isResolved": False,
                                    "isOutdated": False,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "databaseId": 3,
                                                "body": "Ignore this unrelated bot thread",
                                                "path": "c.py",
                                                "line": 30,
                                                "createdAt": "2026-03-23T12:07:14Z",
                                                "author": {"login": "some-other-bot"},
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

        with patch.object(gh_pr_watch, "graphql_json", return_value=payload):
            items = gh_pr_watch.fetch_unresolved_review_threads(
                pr,
                authenticated_login="manoelcalixto",
            )

        self.assertEqual(len(items), 2)
        self.assertEqual(
            [item["author"] for item in items],
            ["github-code-quality", "copilot-pull-request-reviewer"],
        )
        self.assertEqual([item["id"] for item in items], ["1", "2"])

    def test_fetch_unresolved_review_threads_keeps_outdated_threads_visible(self):
        pr = {
            "number": 639,
            "repo": "Electivus/Apex-Log-Viewer",
            "url": "https://github.com/Electivus/Apex-Log-Viewer/pull/639",
        }
        payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "nodes": [
                                {
                                    "isResolved": False,
                                    "isOutdated": True,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "databaseId": 11,
                                                "body": "Outdated but still unresolved",
                                                "path": "a.py",
                                                "line": 42,
                                                "createdAt": "2026-03-23T12:41:00Z",
                                                "author": {"login": "github-code-quality"},
                                            }
                                        ]
                                    },
                                }
                            ],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            }
        }

        with patch.object(gh_pr_watch, "graphql_json", return_value=payload):
            items = gh_pr_watch.fetch_unresolved_review_threads(
                pr,
                authenticated_login="manoelcalixto",
            )

        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["is_outdated"])
        self.assertEqual(items[0]["id"], "11")


if __name__ == "__main__":
    unittest.main()
