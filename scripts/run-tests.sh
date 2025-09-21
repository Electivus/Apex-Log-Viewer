#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
cmd=(node "$script_dir/run-tests.js" "$@")

if [[ -n "${ENABLE_COVERAGE:-}" && "${ENABLE_COVERAGE}" != "0" ]]; then
  current_node_opts="${NODE_OPTIONS:-}"
  if [[ "${current_node_opts}" != *"--enable-source-maps"* ]]; then
    if [[ -n "${current_node_opts}" ]]; then
      export NODE_OPTIONS="--enable-source-maps ${current_node_opts}"
    else
      export NODE_OPTIONS="--enable-source-maps"
    fi
  fi
  cmd=(npx --no-install c8 "${cmd[@]}")
fi

if command -v xvfb-run >/dev/null 2>&1 && [[ -z "${DISPLAY:-}" ]]; then
  xvfb-run -a "${cmd[@]}"
else
  "${cmd[@]}"
fi
