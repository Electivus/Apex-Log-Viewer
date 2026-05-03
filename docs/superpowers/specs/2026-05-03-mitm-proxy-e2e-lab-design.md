# MITM Proxy E2E Lab Design

Date: 2026-05-03

## Background

The current `npm run test:e2e:proxy-lab` validates real-org E2E behavior through an authenticated HTTP proxy, but it does not intercept TLS. That covers proxy routing and proxy authentication, but it misses the common corporate environment where HTTPS traffic is decrypted and re-signed by an internal certificate authority.

The user wants the proxy lab to become more realistic by simulating a corporate SSL/TLS man-in-the-middle proxy, validating against real Salesforce org flows, running locally, and becoming part of the standard GitHub E2E workflow.

## Goals

- Make MITM TLS interception the default behavior of `npm run test:e2e:proxy-lab`.
- Replace the current Tinyproxy-based lab with a MITM proxy setup.
- Keep the runner isolated from direct internet egress so network traffic must pass through the proxy.
- Keep proxy authentication in the lab because corporate proxies often require credentials.
- Explicitly validate both trust states:
  - HTTPS via the MITM proxy fails before the MITM CA is trusted.
  - HTTPS via the MITM proxy succeeds after the MITM CA is trusted.
- Run the real-org CLI and VS Code Playwright E2E suites through this MITM lab.
- Add the MITM proxy lab to the standard GitHub E2E workflow.
- Preserve strict TLS verification in the success path. The success path must trust the MITM CA rather than disabling SSL verification.

## Non-goals

- Do not add a second parallel proxy-lab command for Tinyproxy.
- Do not depend on a real external corporate proxy.
- Do not disable TLS verification as the normal success path.
- Do not change the real-org scratch-org semantics except where needed to run them inside the MITM lab.
- Do not introduce a new cache layout for Apex logs.

## Current context

The repository already has:

- `docker-compose.e2e-proxy.yml` with `proxy` and `runner` services.
- `test/e2e/proxy-lab/run.sh` that verifies direct egress blocking, unauthenticated proxy failure, authenticated proxy success, dependency installation, Node `fetch()`, and then runs an E2E command.
- `scripts/run-e2e-proxy-lab.js` and `npm run test:e2e:proxy-lab`.
- Real-org Playwright suites:
  - `npm run test:e2e:cli`
  - `npm run test:e2e`
  - `npm run test:e2e:telemetry`
- E2E proxy helpers in `test/e2e/utils/proxy.ts` that propagate proxy settings to Node, Salesforce CLI, VS Code, and Chromium launch args.
- Rust runtime HTTP client configuration with native root and system proxy support in `crates/alv-core/Cargo.toml`.

## Proposed approach

Use `mitmdump` as the `proxy` service in the existing Docker Compose lab. The proxy service owns the generated MITM CA material and exposes the CA certificate to the runner through a shared Docker volume.

The runner starts without trusting the MITM CA. It first proves the negative TLS case, then installs the CA into the system trust store and exports runtime-specific CA environment variables so the rest of the E2E flow uses verified TLS through the MITM proxy.

### Compose topology

- `runner`
  - Attached only to the internal Compose network.
  - Has no direct internet egress.
  - Uses standard `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and lowercase variants.
  - Receives a shared CA volume from the proxy service.
- `proxy`
  - Attached to the internal network and an external egress network.
  - Runs the MITM proxy on `http://proxy:8888`.
  - Requires Basic authentication using the existing test-only credentials.
  - Writes its generated CA certificate into the shared CA volume.

### Trust validation flow

`test/e2e/proxy-lab/run.sh` should perform these checks in order:

1. Confirm direct internet egress from `runner` fails.
2. Confirm unauthenticated proxy egress fails.
3. Confirm authenticated HTTPS through the MITM proxy fails before the CA is trusted.
4. Install the MITM CA into the runner OS trust store.
5. Export the trust settings needed by the E2E stack:
   - `NODE_USE_SYSTEM_CA=1`
   - `ALV_E2E_USE_SYSTEM_CA=1`
   - `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/alv-mitmproxy-ca.crt`
   - `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`
   - keep `ALV_E2E_PROXY_STRICT_SSL` unset
6. Confirm authenticated HTTPS succeeds through the MITM proxy with `curl`.
7. Confirm Node `fetch()` succeeds through the MITM proxy.
8. Confirm Salesforce CLI can reach Salesforce through the MITM proxy before running the full suite.
9. Run the requested E2E command, defaulting to `npm run test:e2e`.

### Real-org behavior

The lab must continue to use real-org inputs, with a stricter container requirement:

- `SF_DEVHUB_AUTH_URL` is required for containerized proxy-lab runs so the clean runner can authenticate the Dev Hub inside the container.
- `SF_DEVHUB_ALIAS` remains the container-local alias assigned to the authenticated Dev Hub. If unset, the lab uses `ConfiguredDevHub`.
- `SF_DEVHUB_AUTH_URL`, `SF_DEVHUB_ALIAS`, `SF_SCRATCH_STRATEGY=pool`, and `SF_SCRATCH_POOL_NAME` in CI.

The runner authenticates the Dev Hub from `SF_DEVHUB_AUTH_URL` before creating or leasing the scratch org. Documentation must direct local MITM runs to pass `SF_DEVHUB_AUTH_URL`, because host Salesforce CLI aliases are not guaranteed to exist inside the clean runner container.

### CI integration

The GitHub E2E workflow should run the real-org E2E commands through `npm run test:e2e:proxy-lab`:

- CLI E2E:
  - `npm run test:e2e:proxy-lab -- npm run test:e2e:cli`
- VS Code E2E:
  - If Azure telemetry validation is configured, keep Azure resolution and Log Analytics validation on the GitHub runner host, but launch the Playwright child run through `npm run test:e2e:proxy-lab -- npm run test:e2e`.
  - Otherwise run `npm run test:e2e:proxy-lab -- npm run test:e2e`.

The workflow should keep the same scratch-org pool environment contract. The telemetry connection string and test run id must be passed into the proxy-lab runner so extension telemetry is emitted from inside the MITM environment. Azure CLI authentication state remains on the GitHub runner host, not inside the container.

### Documentation

Update `docs/TESTING.md` to describe the MITM lab:

- It simulates corporate SSL interception.
- It validates the negative untrusted-CA case and the positive trusted-CA case.
- It runs with strict SSL verification enabled after trusting the CA.
- It runs in CI as the standard E2E path.
- Local users must pass `SF_DEVHUB_AUTH_URL` for containerized proxy-lab runs because host Salesforce CLI auth aliases are not guaranteed to exist inside the runner.

## Alternatives considered

### Alternative 1: Replace Tinyproxy with MITM proxy in the existing command

This is the recommended approach. It directly matches the user request and keeps a single authoritative proxy lab command. It validates routing, proxy auth, TLS interception, trust-store setup, and real-org behavior in one path.

### Alternative 2: Add a separate MITM command and keep Tinyproxy

This would reduce risk during transition but would leave two proxy labs with different meanings. The user explicitly requested that MITM become the default behavior of `test:e2e:proxy-lab`, so this approach is not preferred.

### Alternative 3: Use an external corporate MITM proxy in CI

This would be realistic but fragile. It would make the open-source CI depend on private infrastructure, secrets, and network availability outside the repository. The local Compose lab is more reproducible.

## Risks and mitigations

- **Generated CA race:** The runner might start before the MITM CA exists. Mitigate with a proxy healthcheck that verifies the proxy port and CA file are ready, plus runner-side polling.
- **Different trust stores:** Node, curl, Salesforce CLI, Electron/VS Code, and Rust may consult different trust sources. Mitigate by installing the CA into the OS store and exporting explicit CA env vars for Node and OpenSSL-compatible tools.
- **Telemetry path dependencies:** The existing telemetry wrapper uses Azure CLI for Log Analytics queries. Mitigate by keeping Azure resolution and validation on the GitHub runner host while running only the Playwright child command inside the MITM proxy lab.
- **Longer CI runtime:** The lab builds images and performs extra trust checks. This is accepted by the user for the open-source project.
- **Podman/Docker differences:** Local Podman Docker compatibility can differ from Docker Engine. Mitigate by validating `docker compose config`, then running the lab locally with the enabled Podman compatibility layer.

## Verification strategy

Before claiming completion, run verification in layers:

1. Unit/script checks:
   - `npm run test:e2e:utils`
   - the script test covering `scripts/run-e2e-proxy-lab.js`
   - any new proxy-lab helper tests
2. Container smoke:
   - `npm run test:e2e:proxy-lab -- bash -lc 'echo proxy-lab-smoke'`
3. Real-org CLI path:
   - `npm run test:e2e:proxy-lab -- npm run test:e2e:cli`
4. Real-org VS Code path:
   - `npm run test:e2e:proxy-lab -- npm run test:e2e`
5. CI path:
   - verify the GitHub workflow invokes the proxy lab for CLI and VS Code E2E.

If local real-org or CI-equivalent verification cannot run because credentials are unavailable, the final report must say exactly what was not run and why.
