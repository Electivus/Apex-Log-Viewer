#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo_root"
config_file="${XDG_CONFIG_HOME:-$HOME/.config}/electivus/apex-log-viewer/e2e-macos.sh"
if [[ ! -f "$config_file" ]]; then
  echo '[e2e:macos] Configure the private e2e-macos.sh operator file first; see docs/DEVHUB_LOCAL.md.' >&2
  exit 1
fi
# Non-secret, operator-owned Node, isolated Salesforce CLI and scratch settings.
# shellcheck source=/dev/null
source "$config_file"
node -e 'require("./scripts/local-e2e-bootstrap").assertSupportedNode()'
: "${ALV_SF_BIN_PATH:?Configure the isolated Salesforce CLI Node wrapper in e2e-macos.sh.}"
if [[ "$ALV_SF_BIN_PATH" != /* || ! -x "$ALV_SF_BIN_PATH" ]]; then
  echo '[e2e:macos] ALV_SF_BIN_PATH must select an executable absolute Salesforce CLI wrapper path.' >&2
  exit 1
fi
export SF_CLI_BIN_PATH="$ALV_SF_BIN_PATH"
export PLAYWRIGHT_WORKERS="${PLAYWRIGHT_WORKERS:-1}"
unset PLAYWRIGHT_MCP_CDP_ENDPOINT ELECTRON_RUN_AS_NODE

case "${1:-}" in
verify)
  shift
  exec node scripts/devhub-local.js verify "$@"
  ;;
run)
  shift
  if [[ "${1:-}" == -- && $# -ge 2 ]]; then
    shift
    exec node scripts/devhub-local.js run -- "$@"
  fi
  ;;
esac
echo 'Usage: bash scripts/run-macos-e2e.sh verify | run -- <command> [args]' >&2
exit 2
