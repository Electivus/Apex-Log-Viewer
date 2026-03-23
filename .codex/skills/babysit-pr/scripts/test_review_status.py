import pathlib
import sys
import unittest


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


if __name__ == "__main__":
    unittest.main()
