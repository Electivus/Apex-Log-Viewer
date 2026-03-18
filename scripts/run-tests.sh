#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
exec node "$script_dir/run-tests-cli.js" "$@"
