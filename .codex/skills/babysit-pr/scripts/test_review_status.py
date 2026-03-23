import pathlib
import sys
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import gh_pr_watch


class ReviewStatusTests(unittest.TestCase):
    def _base_pr(self, **overrides):
        pr = {
            "closed": False,
            "merged": False,
            "mergeable": "MERGEABLE",
            "merge_state_status": "CLEAN",
            "review_decision": "",
        }
        pr.update(overrides)
        return pr

    def _green_checks(self, **overrides):
        checks = {
            "all_terminal": True,
            "failed_count": 0,
            "pending_count": 0,
            "passed_count": 5,
        }
        checks.update(overrides)
        return checks

    def test_build_review_signal_marks_codex_eyes_as_in_review(self):
        signal = gh_pr_watch.build_review_signal(
            [
                {
                    "author": "chatgpt-codex-connector[bot]",
                    "content": "eyes",
                    "id": "1",
                }
            ]
        )

        self.assertEqual(signal["status"], "in_review")
        self.assertTrue(signal["codex_review_in_progress"])
        self.assertEqual(len(signal["codex_eyes_reactions"]), 1)

    def test_build_review_signal_marks_requested_copilot_as_awaiting_review(self):
        signal = gh_pr_watch.build_review_signal(
            reactions=[],
            requested_reviewers=["copilot-pull-request-reviewer"],
            latest_review_authors=["github-code-quality"],
        )

        self.assertEqual(signal["status"], "awaiting_review")
        self.assertFalse(signal["codex_review_in_progress"])
        self.assertEqual(signal["pending_reviewers"], ["copilot-pull-request-reviewer"])

    def test_build_review_signal_marks_requested_github_code_quality_as_awaiting_review(self):
        signal = gh_pr_watch.build_review_signal(
            reactions=[],
            requested_reviewers=["github-code-quality"],
            latest_review_authors=[],
        )

        self.assertEqual(signal["status"], "awaiting_review")
        self.assertFalse(signal["codex_review_in_progress"])
        self.assertEqual(signal["pending_reviewers"], ["github-code-quality"])

    def test_codex_in_review_blocks_ready_to_merge(self):
        ready = gh_pr_watch.is_pr_ready_to_merge(
            self._base_pr(),
            self._green_checks(),
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
            review_signal={
                "status": "in_review",
                "codex_review_in_progress": True,
                "codex_eyes_reactions": [{"id": "1"}],
            },
        )

        self.assertFalse(ready)

    def test_awaiting_review_blocks_ready_to_merge(self):
        ready = gh_pr_watch.is_pr_ready_to_merge(
            self._base_pr(),
            self._green_checks(),
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
            review_signal={
                "status": "awaiting_review",
                "codex_review_in_progress": False,
                "codex_eyes_reactions": [],
                "pending_reviewers": ["copilot-pull-request-reviewer"],
            },
        )

        self.assertFalse(ready)

    def test_recommend_actions_reports_review_in_progress_when_codex_has_eyes(self):
        actions = gh_pr_watch.recommend_actions(
            self._base_pr(),
            self._green_checks(),
            failed_runs=[],
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
            review_signal={
                "status": "in_review",
                "codex_review_in_progress": True,
                "codex_eyes_reactions": [{"id": "1"}],
            },
            retries_used=0,
            max_retries=3,
        )

        self.assertEqual(actions, ["review_in_progress"])

    def test_recommend_actions_reports_awaiting_review_for_pending_copilot(self):
        actions = gh_pr_watch.recommend_actions(
            self._base_pr(),
            self._green_checks(),
            failed_runs=[],
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
            review_signal={
                "status": "awaiting_review",
                "codex_review_in_progress": False,
                "codex_eyes_reactions": [],
                "pending_reviewers": ["copilot-pull-request-reviewer"],
            },
            retries_used=0,
            max_retries=3,
        )

        self.assertEqual(actions, ["awaiting_review"])

    def test_is_ci_green_is_false_while_codex_review_is_in_progress(self):
        green = gh_pr_watch.is_ci_green(
            {
                "checks": self._green_checks(),
                "review_signal": {
                    "status": "in_review",
                    "codex_review_in_progress": True,
                    "codex_eyes_reactions": [{"id": "1"}],
                },
            }
        )

        self.assertFalse(green)

    def test_is_ci_green_is_false_while_awaiting_review(self):
        green = gh_pr_watch.is_ci_green(
            {
                "checks": self._green_checks(),
                "review_signal": {
                    "status": "awaiting_review",
                    "codex_review_in_progress": False,
                    "codex_eyes_reactions": [],
                    "pending_reviewers": ["copilot-pull-request-reviewer"],
                },
            }
        )

        self.assertFalse(green)

    def test_fetch_review_signal_context_ignores_ai_reviews_from_older_shas(self):
        pr = {
            "number": 639,
            "repo": "Electivus/Apex-Log-Viewer",
            "head_sha": "newsha",
        }
        graphql_payload = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewRequests": {
                            "nodes": [
                                {
                                    "requestedReviewer": {
                                        "login": "copilot-pull-request-reviewer",
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        }
        reviews_payload = [
            {
                "commit_id": "oldsha",
                "user": {"login": "copilot-pull-request-reviewer"},
            },
            {
                "commit_id": "newsha",
                "user": {"login": "github-code-quality"},
            },
        ]

        with patch.object(gh_pr_watch, "graphql_json", return_value=graphql_payload), patch.object(
            gh_pr_watch,
            "gh_api_list_paginated",
            return_value=reviews_payload,
        ):
            context = gh_pr_watch.fetch_review_signal_context(pr)

        self.assertEqual(context["requested_reviewers"], ["copilot-pull-request-reviewer"])
        self.assertEqual(context["latest_review_authors"], ["github-code-quality"])


if __name__ == "__main__":
    unittest.main()
