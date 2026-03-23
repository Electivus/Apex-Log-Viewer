import pathlib
import sys
import unittest


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import gh_pr_watch


class ReadyStateTests(unittest.TestCase):
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

    def test_review_required_no_longer_blocks_ready_state(self):
        ready = gh_pr_watch.is_pr_ready_to_merge(
            self._base_pr(merge_state_status="BLOCKED", review_decision="REVIEW_REQUIRED"),
            self._green_checks(),
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
        )

        self.assertTrue(ready)

    def test_recommend_actions_stops_when_only_approval_is_missing(self):
        actions = gh_pr_watch.recommend_actions(
            self._base_pr(merge_state_status="BLOCKED", review_decision="REVIEW_REQUIRED"),
            self._green_checks(),
            failed_runs=[],
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
            retries_used=0,
            max_retries=3,
        )

        self.assertEqual(actions, ["stop_ready_to_merge"])

    def test_dirty_pr_is_not_ready_even_when_checks_are_green(self):
        ready = gh_pr_watch.is_pr_ready_to_merge(
            self._base_pr(merge_state_status="DIRTY", review_decision="REVIEW_REQUIRED"),
            self._green_checks(),
            new_review_items=[],
            unresolved_review_threads=[],
            blocking_non_thread_feedback=[],
            ready_reactions=[],
        )

        self.assertFalse(ready)


if __name__ == "__main__":
    unittest.main()
