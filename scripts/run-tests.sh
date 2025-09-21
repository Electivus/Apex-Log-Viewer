#!/usr/bin/env bash
set -euo pipefail

if command -v xvfb-run >/dev/null 2>&1 && [ -z "${DISPLAY:-}" ]; then
  xvfb-run -a node "$(dirname "$0")/run-tests.js" "$@"
else
  node "$(dirname "$0")/run-tests.js" "$@"
fi
