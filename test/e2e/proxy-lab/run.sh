#!/usr/bin/env bash
set -euo pipefail

echo "[proxy-lab] Verifying that direct internet egress is blocked..."
if curl --noproxy '*' --connect-timeout 5 --max-time 10 -fsS https://example.com >/dev/null 2>&1; then
  echo "[proxy-lab] Direct egress unexpectedly succeeded. The runner is not isolated." >&2
  exit 1
fi

echo "[proxy-lab] Verifying that the proxy rejects unauthenticated internet egress..."
if curl --proxy http://proxy:8888 --connect-timeout 5 --max-time 10 -fsS https://example.com >/dev/null 2>&1; then
  echo "[proxy-lab] Unauthenticated proxy egress unexpectedly succeeded." >&2
  exit 1
fi

echo "[proxy-lab] Verifying that internet egress works through the authenticated proxy..."
curl --connect-timeout 10 --max-time 30 -fsS https://example.com >/dev/null

if [[ "${ALV_E2E_PROXY_LAB_SKIP_NPM_CI:-}" != "1" ]]; then
  echo "[proxy-lab] Installing npm dependencies through the proxy..."
  npm ci
else
  echo "[proxy-lab] Skipping npm ci because ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1."
fi

echo "[proxy-lab] Verifying Node fetch through the configured proxy..."
node - <<'NODE'
const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());
fetch('https://example.com', { signal: AbortSignal.timeout(30_000) })
  .then(response => {
    if (!response.ok) {
      throw new Error(`Unexpected status ${response.status}`);
    }
  })
  .catch(error => {
    console.error(`[proxy-lab] Node fetch through proxy failed: ${error.message}`);
    process.exitCode = 1;
  });
NODE

if [[ "$#" -gt 0 ]]; then
  echo "[proxy-lab] Running command: $*"
  exec "$@"
fi

if [[ -n "${ALV_E2E_PROXY_LAB_COMMAND:-}" ]]; then
  echo "[proxy-lab] Running command: ${ALV_E2E_PROXY_LAB_COMMAND}"
  exec bash -lc "${ALV_E2E_PROXY_LAB_COMMAND}"
fi

echo "[proxy-lab] Running default command: npm run test:e2e"
exec npm run test:e2e
