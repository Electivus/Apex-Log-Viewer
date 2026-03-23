#!/usr/bin/env python3
"""Backward-compatible wrapper for the neutral PR review feedback script."""

import gh_pr_review_feedback as _review_feedback

# Preserve the legacy module surface while delegating to the neutral entrypoint.
__all__ = tuple(
    getattr(
        _review_feedback,
        "__all__",
        [name for name in dir(_review_feedback) if not name.startswith("_")],
    )
)
for _name in __all__:
    globals()[_name] = getattr(_review_feedback, _name)


if __name__ == "__main__":
    raise SystemExit(_review_feedback.main())
