#!/usr/bin/env bash
set -euo pipefail

# Scope runtime settings to this command. Credentials are supplied by the
# existing JWT wrapper from the private Linux operator root.
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo_root"
if [[ ! -x /usr/bin/node ]]; then
  echo '[e2e:wsl] Install the Arch nodejs-lts package matching .nvmrc first.' >&2
  exit 1
fi
# This operator uses Arch's system Node. Also select it in child commands whose
# launchers use /usr/bin/env node, even from an older terminal environment.
export PATH="/usr/bin:$HOME/.local/bin:$PATH"
node -e 'require("./scripts/local-e2e-bootstrap").assertSupportedSystemNode()'

config_file="${XDG_CONFIG_HOME:-$HOME/.config}/electivus/apex-log-viewer/e2e.sh"
if [[ -f "$config_file" ]]; then
  # This operator-owned file contains non-secret pool/runtime settings only.
  # shellcheck source=/dev/null
  source "$config_file"
fi
export SALESFORCE_CLI_CACHE_ROOT="${SALESFORCE_CLI_CACHE_ROOT:-$HOME/.local/share/electivus/apex-log-viewer/salesforce-cli}"
ALV_SF_BIN_PATH=$(node --input-type=module -e '
  import {resolveSalesforceCliCacheConfig, resolveSalesforceCliBinPath} from "./scripts/setup-salesforce-cli.mjs";
  process.stdout.write(resolveSalesforceCliBinPath(resolveSalesforceCliCacheConfig().cacheDir));
')
if [[ ! -x "$ALV_SF_BIN_PATH" ]]; then
  echo "[e2e:wsl] Run node scripts/setup-salesforce-cli.mjs with SALESFORCE_CLI_CACHE_ROOT set first." >&2
  exit 1
fi
export ALV_SF_BIN_PATH
export SF_CLI_BIN_PATH="$ALV_SF_BIN_PATH"
PATH="$(dirname -- "$ALV_SF_BIN_PATH"):$PATH"
export PATH
export JAVA_HOME="${JAVA_HOME_21_X64:-${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk}}"
export PLAYWRIGHT_WORKERS="${PLAYWRIGHT_WORKERS:-1}"
# Never attach test automation to the operator's browser or Electron process.
unset PLAYWRIGHT_MCP_CDP_ENDPOINT ELECTRON_RUN_AS_NODE

suite=${1:-ui}
if [[ $# -gt 0 ]]; then shift; fi
case "$suite" in
verify)
  exec node scripts/devhub-local.js verify "$@"
  ;;
cli | ui | intellij | telemetry | run)
  : "${SF_SCRATCH_POOL_NAME:?Configure SF_SCRATCH_POOL_NAME in the local e2e.sh file.}"
  export SF_SCRATCH_STRATEGY=pool
  ;;
*)
  echo 'Usage: bash scripts/run-wsl-e2e.sh {verify|cli|ui|intellij|telemetry} [Playwright arguments] | run -- <command> [args]' >&2
  exit 2
  ;;
esac

case "$suite" in
run)
  if [[ "${1:-}" != -- || $# -lt 2 ]]; then
    echo 'Usage: bash scripts/run-wsl-e2e.sh run -- <command> [args]' >&2
    exit 2
  fi
  shift
  exec node scripts/devhub-local.js run -- "$@"
  ;;
cli)
  exec node scripts/devhub-local.js run -- corepack pnpm run test:e2e:cli "$@"
  ;;
intellij)
  export ALV_INTELLIJ_REAL_ORG_E2E=1
  exec node scripts/devhub-local.js run -- corepack pnpm run test:e2e:cli test/e2e/cli/specs/intellijNative.e2e.spec.ts "$@"
  ;;
ui | telemetry)
  command -v xvfb-run >/dev/null
  test_script=test:e2e
  if [[ "$suite" == telemetry ]]; then test_script=test:e2e:telemetry; fi
  exec xvfb-run -a -s '-screen 0 1280x1024x24' \
    node scripts/devhub-local.js run -- corepack pnpm run "$test_script" "$@"
  ;;
esac
