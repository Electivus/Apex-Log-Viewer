#!/usr/bin/env bash
set -euo pipefail

MITM_CA_SOURCE="${ALV_E2E_PROXY_LAB_MITM_CA_SOURCE:-/mitmproxy/mitmproxy-ca-cert.cer}"
MITM_CA_DEST="${ALV_E2E_PROXY_LAB_MITM_CA_DEST:-/usr/local/share/ca-certificates/alv-mitmproxy-ca.crt}"
SYSTEM_CA_BUNDLE="${ALV_E2E_PROXY_LAB_SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
DEVHUB_ALIAS="${SF_DEVHUB_ALIAS:-ConfiguredDevHub}"
HOST_GENERATED_PATHS=(
  "apps/vscode-extension/bin"
  "apps/vscode-extension/dist"
  "apps/vscode-extension/media"
  "apps/vscode-extension/node_modules/tree-sitter-sfapex"
  "apexlogs"
  "dist"
  "out"
  "output"
)

export SF_SKIP_NEW_VERSION_CHECK="${SF_SKIP_NEW_VERSION_CHECK:-true}"
export SF_DISABLE_TELEMETRY="${SF_DISABLE_TELEMETRY:-true}"
export SFDX_DISABLE_TELEMETRY="${SFDX_DISABLE_TELEMETRY:-true}"
export SF_DISABLE_LOG_FILE="${SF_DISABLE_LOG_FILE:-true}"
export SFDX_DISABLE_LOG_FILE="${SFDX_DISABLE_LOG_FILE:-true}"
export SF_AUTOUPDATE_DISABLE="${SF_AUTOUPDATE_DISABLE:-true}"
export SFDX_AUTOUPDATE_DISABLE="${SFDX_AUTOUPDATE_DISABLE:-true}"
export SF_DISABLE_AUTOUPDATE="${SF_DISABLE_AUTOUPDATE:-true}"
export SFDX_DISABLE_AUTOUPDATE="${SFDX_DISABLE_AUTOUPDATE:-true}"

fail() {
  echo "[proxy-lab] $*" >&2
  exit 1
}

validate_salesforce_cli_package() {
  local package_name="$1"
  if [[ ! "${package_name}" =~ ^@salesforce/cli@([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|nightly)$ ]]; then
    fail "ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE must be @salesforce/cli pinned to an exact version, for example @salesforce/cli@2.136.8."
  fi
}

restore_host_ownership() {
  local host_uid="${ALV_E2E_PROXY_LAB_HOST_UID:-}"
  local host_gid="${ALV_E2E_PROXY_LAB_HOST_GID:-}"

  if [[ -z "${host_uid}" || -z "${host_gid}" ]]; then
    return 0
  fi
  if ! [[ "${host_uid}" =~ ^[0-9]+$ && "${host_gid}" =~ ^[0-9]+$ ]]; then
    echo "[proxy-lab] Skipping host ownership restore because host uid/gid are invalid." >&2
    return 0
  fi

  local existing_paths=()
  local path
  for path in "${HOST_GENERATED_PATHS[@]}"; do
    if [[ -e "${path}" ]]; then
      existing_paths+=("${path}")
    fi
  done

  if [[ "${#existing_paths[@]}" -gt 0 ]]; then
    echo "[proxy-lab] Restoring ownership for generated bind-mounted paths..."
    chown -R "${host_uid}:${host_gid}" "${existing_paths[@]}" || true
  fi
}

trap restore_host_ownership EXIT

wait_for_mitm_ca() {
  echo "[proxy-lab] Waiting for mitmproxy CA at ${MITM_CA_SOURCE}..."
  local deadline=$((SECONDS + 120))
  while [[ "${SECONDS}" -lt "${deadline}" ]]; do
    if [[ -s "${MITM_CA_SOURCE}" ]]; then
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for mitmproxy CA at ${MITM_CA_SOURCE}."
}

verify_direct_egress_blocked() {
  echo "[proxy-lab] Verifying that direct internet egress is blocked..."
  if curl --noproxy '*' --connect-timeout 5 --max-time 10 -fsS https://example.com >/dev/null 2>&1; then
    fail "Direct egress unexpectedly succeeded. The runner is not isolated."
  fi
}

verify_unauthenticated_proxy_blocked() {
  echo "[proxy-lab] Verifying that the proxy rejects unauthenticated internet egress..."
  local status
  status="$(curl --proxy http://proxy:8888 --connect-timeout 5 --max-time 10 -sS -o /dev/null -w '%{http_code}' http://example.com || true)"
  if [[ "${status}" != "407" ]]; then
    fail "Unauthenticated proxy egress returned HTTP ${status:-unknown}; expected 407 Proxy Authentication Required."
  fi
}

verify_mitm_ca_not_trusted_yet() {
  echo "[proxy-lab] Verifying authenticated HTTPS fails before trusting the MITM CA..."
  local stderr_file
  stderr_file="$(mktemp)"
  if curl --connect-timeout 10 --max-time 30 -fsS https://example.com >/dev/null 2>"${stderr_file}"; then
    rm -f "${stderr_file}"
    fail "Authenticated HTTPS unexpectedly succeeded before the MITM CA was trusted."
  fi
  if ! grep -Eiq 'certificate|SSL|issuer|self-signed|unable to get local issuer' "${stderr_file}"; then
    echo "[proxy-lab] curl failure before CA trust did not look certificate-related:" >&2
    cat "${stderr_file}" >&2
    rm -f "${stderr_file}"
    exit 1
  fi
  rm -f "${stderr_file}"
}

install_mitm_ca() {
  echo "[proxy-lab] Installing mitmproxy CA into the runner trust store..."
  cp "${MITM_CA_SOURCE}" "${MITM_CA_DEST}"
  update-ca-certificates

  export NODE_USE_SYSTEM_CA=1
  export ALV_E2E_USE_SYSTEM_CA=1
  export NODE_EXTRA_CA_CERTS="${MITM_CA_DEST}"
  export SSL_CERT_FILE="${SYSTEM_CA_BUNDLE}"
}

verify_authenticated_mitm_proxy() {
  echo "[proxy-lab] Verifying internet egress works through the authenticated MITM proxy..."
  curl --connect-timeout 10 --max-time 30 -fsS https://example.com >/dev/null
}

install_dependencies() {
  if [[ "${ALV_E2E_PROXY_LAB_SKIP_NPM_CI:-}" != "1" ]]; then
    echo "[proxy-lab] Installing npm dependencies through the MITM proxy..."
    npm ci
  else
    echo "[proxy-lab] Skipping npm ci because ALV_E2E_PROXY_LAB_SKIP_NPM_CI=1."
  fi
}

install_salesforce_cli_override() {
  local package_name="${ALV_E2E_PROXY_LAB_SF_CLI_PACKAGE:-}"
  if [[ -z "${package_name}" ]]; then
    return 0
  fi

  echo "[proxy-lab] Installing Salesforce CLI override: ${package_name}"
  validate_salesforce_cli_package "${package_name}"
  npm install --global "${package_name}"
  sf --version
}

verify_node_https_proxy() {
  echo "[proxy-lab] Verifying Node HTTPS through the configured MITM proxy..."
  node - <<'NODE'
const net = require('node:net');
const tls = require('node:tls');
const { Buffer } = require('node:buffer');
const { URL } = require('node:url');

const target = new URL('https://example.com/');
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

let proxySocket;
let tlsSocket;

function fail(message) {
  throw new Error(message);
}

function withTimeout(socket, description) {
  socket.setTimeout(30_000, () => {
    socket.destroy(new Error(`${description} timed out`));
  });
}

function connectToProxy(proxy) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : 80
    });
    withTimeout(socket, 'Proxy connection');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readProxyConnectResponse(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    function cleanup() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
    }

    function settle(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    }

    function onError(error) {
      settle(reject, error);
    }

    function onEnd() {
      settle(reject, new Error('Proxy connection ended before CONNECT response headers were complete.'));
    }

    function onClose() {
      settle(reject, new Error('Proxy connection closed before CONNECT response headers were complete.'));
    }

    function onData(chunk) {
      chunks.push(chunk);
      const response = Buffer.concat(chunks);
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      cleanup();
      const remainder = response.subarray(headerEnd + 4);
      if (remainder.length > 0) {
        socket.unshift(remainder);
      }
      settle(resolve, response.subarray(0, headerEnd).toString('latin1'));
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.once('close', onClose);
  });
}

function connectTls(socket) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: target.hostname
    });
    tlsSocket = secureSocket;
    withTimeout(secureSocket, 'TLS connection');
    secureSocket.once('secureConnect', () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

function readHttpsStatusCode(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    function cleanup() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    }

    function statusFromChunks() {
      const response = Buffer.concat(chunks).toString('latin1');
      const statusLine = response.split('\r\n', 1)[0] || '';
      const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})\b/);
      if (!match) {
        fail(`Unexpected HTTPS response status line: ${statusLine || '<empty>'}`);
      }
      return Number(match[1]);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onEnd() {
      cleanup();
      try {
        resolve(statusFromChunks());
      } catch (error) {
        reject(error);
      }
    }

    function onData(chunk) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(Buffer.from('\r\n'))) {
        cleanup();
        resolve(statusFromChunks());
      }
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

async function main() {
  if (!proxyUrl) {
    fail('HTTPS_PROXY/HTTP_PROXY is not configured for Node MITM proxy verification.');
  }

  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== 'http:') {
    fail(`Unsupported proxy protocol for Node MITM proxy verification: ${proxy.protocol}`);
  }

  proxySocket = await connectToProxy(proxy);

  const proxyAuthorization = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    : '';
  proxySocket.write(
    `CONNECT ${target.hostname}:443 HTTP/1.1\r\n` +
    `Host: ${target.hostname}:443\r\n` +
    proxyAuthorization +
    'Proxy-Connection: Keep-Alive\r\n' +
    '\r\n'
  );

  const connectResponse = await readProxyConnectResponse(proxySocket);
  const connectStatusLine = connectResponse.split('\r\n', 1)[0] || '';
  if (!/^HTTP\/1\.[01] 200\b/.test(connectStatusLine)) {
    fail(`Proxy CONNECT failed: ${connectStatusLine || '<empty response>'}`);
  }

  const secureSocket = await connectTls(proxySocket);
  secureSocket.write(
    `GET ${target.pathname} HTTP/1.1\r\n` +
    `Host: ${target.hostname}\r\n` +
    'User-Agent: alv-proxy-lab-node-check\r\n' +
    'Accept: */*\r\n' +
    'Connection: close\r\n' +
    '\r\n'
  );

  const statusCode = await readHttpsStatusCode(secureSocket);
  if (statusCode < 200 || statusCode >= 400) {
    fail(`Unexpected HTTPS status through MITM proxy: ${statusCode}`);
  }
  secureSocket.end();
}

main().catch(error => {
  if (tlsSocket) {
    tlsSocket.destroy();
  } else if (proxySocket) {
    proxySocket.destroy();
  }
  console.error(`[proxy-lab] Node HTTPS through MITM proxy failed: ${error.message}`);
  process.exitCode = 1;
});
NODE
}

redact_salesforce_cli_output() {
  sed -E \
    -e 's#force://[^[:space:]]+#force://[redacted]#g' \
    -e 's#"(accessToken|refreshToken|clientSecret)"[[:space:]]*:[[:space:]]*"[^"]+"#"\1":"[redacted]"#g'
}

run_sf_preflight_command() {
  local description="$1"
  shift
  local output_file
  output_file="$(mktemp)"
  local status=0

  "$@" >"${output_file}" 2>&1 || status=$?
  if [[ "${status}" -eq 0 ]]; then
    rm -f "${output_file}"
    return 0
  fi

  echo "[proxy-lab] Salesforce CLI preflight failed while ${description} (exit ${status})." >&2
  if [[ -s "${output_file}" ]]; then
    redact_salesforce_cli_output <"${output_file}" >&2
  fi
  rm -f "${output_file}"
  return "${status}"
}

requested_command_requires_devhub() {
  if [[ "$#" -eq 0 && -z "${ALV_E2E_PROXY_LAB_COMMAND:-}" ]]; then
    return 0
  fi

  local requested_command="$* ${ALV_E2E_PROXY_LAB_COMMAND:-}"
  case "${requested_command}" in
    *"test:e2e"*)
      return 0
      ;;
  esac

  return 1
}

preflight_salesforce_cli() {
  if [[ -z "${SF_DEVHUB_AUTH_URL:-}" ]]; then
    if requested_command_requires_devhub "$@"; then
      fail "SF_DEVHUB_AUTH_URL is required for real-org proxy-lab commands because the clean runner container cannot use host Salesforce CLI aliases. Export a Dev Hub SFDX auth URL or pass an explicit non-real-org smoke command after '--'."
    fi
    echo "[proxy-lab] Skipping Salesforce CLI network preflight because SF_DEVHUB_AUTH_URL is not set and the requested command does not look like a real-org E2E run."
    return 0
  fi

  echo "[proxy-lab] Verifying Salesforce CLI through the authenticated MITM proxy..."
  local auth_file
  auth_file="$(mktemp)"
  trap 'rm -f "${auth_file}"' RETURN ERR
  chmod 0600 "${auth_file}"
  printf '%s' "${SF_DEVHUB_AUTH_URL}" >"${auth_file}"
  run_sf_preflight_command \
    "authenticating Dev Hub alias '${DEVHUB_ALIAS}'" \
    sf org login sfdx-url --sfdx-url-file "${auth_file}" --set-default-dev-hub --alias "${DEVHUB_ALIAS}" --json
  run_sf_preflight_command \
    "displaying Dev Hub alias '${DEVHUB_ALIAS}'" \
    sf org display -o "${DEVHUB_ALIAS}" --json
  rm -f "${auth_file}"
  trap - RETURN ERR
}

run_requested_command() {
  if [[ "$#" -gt 0 ]]; then
    echo "[proxy-lab] Running command: $*"
    "$@"
    return
  fi

  if [[ -n "${ALV_E2E_PROXY_LAB_COMMAND:-}" ]]; then
    echo "[proxy-lab] Running command: ${ALV_E2E_PROXY_LAB_COMMAND}"
    bash -lc "${ALV_E2E_PROXY_LAB_COMMAND}"
    return
  fi

  echo "[proxy-lab] Running default command: npm run test:e2e"
  npm run test:e2e
}

wait_for_mitm_ca
verify_direct_egress_blocked
verify_unauthenticated_proxy_blocked
verify_mitm_ca_not_trusted_yet
install_mitm_ca
verify_authenticated_mitm_proxy
install_dependencies
verify_node_https_proxy
install_salesforce_cli_override
preflight_salesforce_cli "$@"
run_requested_command "$@"
