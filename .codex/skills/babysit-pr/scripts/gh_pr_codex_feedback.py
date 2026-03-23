#!/usr/bin/env python3
"""Backward-compatible wrapper for the neutral PR review feedback script."""

from gh_pr_review_feedback import *  # noqa: F401,F403
from gh_pr_review_feedback import main


if __name__ == "__main__":
    raise SystemExit(main())
