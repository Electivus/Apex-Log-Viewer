#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
node "$script_dir/clean-vscode-test.js"
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
  webview_exclude="src/webview/**"
  if [[ -n "${C8_EXCLUDE:-}" ]]; then
    if [[ ",${C8_EXCLUDE}," != *",${webview_exclude},"* ]]; then
      export C8_EXCLUDE="${webview_exclude},${C8_EXCLUDE}"
    fi
  else
    export C8_EXCLUDE="${webview_exclude}"
  fi
  report_dir="coverage/extension"
  mkdir -p "${report_dir}"
  cmd=(npx --no-install c8 --exclude "${webview_exclude}" --exclude-after-remap --report-dir "${report_dir}" --reporter=json --reporter=json-summary --reporter=lcovonly --reporter=html "${cmd[@]}")
fi

if command -v xvfb-run >/dev/null 2>&1 && [[ -z "${DISPLAY:-}" ]]; then
  xvfb-run -a "${cmd[@]}"
else
  "${cmd[@]}"
fi
