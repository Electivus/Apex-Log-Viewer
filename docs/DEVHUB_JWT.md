# Direct validation with Dev Hub JWT

This is the direct-runner slice of [#1074](https://github.com/Electivus/Apex-Log-Viewer/issues/1074), integrated on the `codex/devhub-jwt` effort branch. Production workflow credential gates, pool administration, proxy-lab transport and permanent identity provisioning have separate tickets. The existing production workflow contract must be cut over together in #1078 before this effort reaches `main`.

## Configuration

The JavaScript runner (`scripts/run-tests.js`) and TypeScript E2E runner (`ensureScratchOrg`) use `scripts/devhub-auth.js` through their existing Salesforce CLI adapters.

| Variable                     | Meaning                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `SF_DEVHUB_CLIENT_ID`        | ECA consumer key                                                               |
| `SF_DEVHUB_USERNAME`         | Explicit Salesforce username to authenticate                                   |
| `SF_DEVHUB_LOGIN_URL`        | HTTPS login origin, such as `https://login.salesforce.com`                     |
| `SF_DEVHUB_PRIVATE_KEY_FILE` | Path to a readable, unencrypted RSA PEM private key, at least 2048 bits        |
| `SF_DEVHUB_PRIVATE_KEY`      | Alternative inline PEM; supply exactly one of the two key inputs               |
| `SF_DEVHUB_ALIAS`            | Explicit, already authenticated local alias, available only when JWT is absent |

Any JWT input selects JWT. Partial, malformed or rejected JWT configuration fails without trying an alias, a default identity or an authorization URL. CI requires complete JWT even when a cached alias or `SF_DEVHUB_AUTH_URL` exists. Neither `SF_DEVHUB_AUTH_URL` nor `SFDX_AUTH_URL` is an authentication fallback.

JWT uses the configured username as the target identifier. It does not change the global default Dev Hub or repoint a supplied alias. With an inline key, this username is resolved only in the workflow-owned CLI home. The ECA must already allow certificate-backed login for that user. Permanent user permissions, key storage and certificate lifetime remain separate provisioning decisions.

### Local JWT

In a PowerShell session, set the client ID, username and login origin, then select a key file:

```powershell
$env:SF_DEVHUB_CLIENT_ID = '<ECA consumer key>'
$env:SF_DEVHUB_USERNAME = '<Salesforce username>'
$env:SF_DEVHUB_LOGIN_URL = 'https://login.salesforce.com'
$env:SF_DEVHUB_PRIVATE_KEY_FILE = '<absolute path to private PEM>'
$env:SF_SETUP_SCRATCH = '1'
node scripts/run-tests.js --scope=integration --vscode=stable
```

Replace the placeholders locally; never commit credentials. TypeScript E2E uses the same inputs through `node scripts/run-playwright-cli-e2e.js` or `node scripts/run-playwright-e2e.js`. Use `SF_SCRATCH_STRATEGY=single` for the direct path. Unit-only and VSIX smoke runs do not require Dev Hub credentials.

### Local alias

In a local session with all five JWT inputs absent, set `SF_DEVHUB_ALIAS` to an alias that is already authenticated and set `SF_SETUP_SCRATCH=1` for the JavaScript runner. A selected JWT failure does not enable this mode. Alias mode is unavailable in CI.

## CLI and child-process boundaries

Salesforce CLI **2.150.6** is the version proven by the direct smoke below. To prepare that exact version in the existing cache, use `node scripts/setup-salesforce-cli.mjs --package @salesforce/cli@2.150.6`, then point `SF_CLI_BIN_PATH` at its Salesforce CLI executable. `ALV_SF_BIN_PATH` is also recognized. Windows npm `.cmd` resolution is preserved, including configured paths with spaces. Keep the existing macOS Node 20 wrapper from `setup-salesforce-cli.mjs`; point the binary variables at that wrapper instead of bypassing it. This slice does not change the production CI version pin.

Scratch creation receives `SF_SCRATCH_SIGNUP_CONNECTED_APP=PlatformCLI` and `SF_SCRATCH_SIGNUP_CALLBACK_URL=http://localhost:1717/OauthRedirect` only in its child environment. Dev Hub JWT continues using the ECA. Scratch authorization remains an SFDX authorization URL.

The JavaScript runner's existing `sfdx` fallback translates the shared policy's JWT login, display/export, scratch import, deletion and logout requests to their legacy commands and flags. This compatibility path has adapter regression tests; the real signup/export evidence uses the documented `sf` version above.

Credential export uses `SF_TEMP_SHOW_SECRETS=true` only for the child whose output is consumed privately. Do not set that opt-in globally. The CLI adapter rejects redacted or malformed authorization URLs on export and import, and credential-operation failures do not copy raw CLI output into errors. Proxy configuration, corporate CA trust and TLS verification remain inherited.

## Key lifetime and cleanup

Inline PEM creates a private workflow directory containing the key and the CLI's `.sf`/`.sfdx` state. Only the Dev Hub child processes receive its `USERPROFILE` on Windows or `HOME` on macOS/Linux. The parent environment and existing authorizations for the same username remain intact. Salesforce stores the key path for renewal, so this entire state lives until workflow cleanup, including pool lease release. Tooling caches and renewal retain their originating CLI home; concurrent Dev Hub sessions cannot share authentication by username alone.

After creating a scratch, the runner exports and imports its refresh-token authorization through the supported CLI commands into the caller's normal CLI state. Existing UI/CLI consumers therefore retain their usual access, and `SF_TEST_KEEP_ORG=1` leaves usable scratch authorization after JWT cleanup. Deletion runs with the isolated Dev Hub, then logs out only the exact deleted scratch username in caller state after remote deletion succeeds. Reused scratches can be imported into the isolated state for this deletion. The Dev Hub is never logged out in caller state.

Login failures, scratch setup failures and JavaScript VS Code bootstrap failures clean up workflow-owned state. Caller-owned key files and explicit alias mode retain their normal CLI home and are never removed by JWT cleanup. If scratch authorization transfer fails, the runner reports the retained recovery directory and preserves its only usable credentials rather than silently losing scratch access. Recover or delete that scratch using the reported CLI home, then remove that owned directory. Other key/state cleanup failures similarly identify the exact remaining directory without credential values. An abrupt OS/process termination can require manual cleanup.

## Controlled smoke and observed results

Run only with an authorized test identity and scratch capacity. The smoke creates two one-day scratch orgs sequentially, one through each existing runner setup path, and deletes them. It creates independent temporary CLI homes and removes their credential state on completion or failure.

With complete JWT inputs already supplied:

```powershell
$env:ALV_DEVHUB_JWT_SMOKE = '1'
$env:ALV_JWT_SMOKE_DEVHUB_ORG_ID = '<verified authorized Dev Hub org ID>'
node scripts/run-playwright-cli-e2e.js test/e2e/cli/devhubJwt.e2e.spec.ts --workers=1 --retries=0 --reporter=list --output=apexlogs/jwt-smoke-results
```

Revalidated on **2026-09-06** (America/Bahia), Windows 11, Node **24.19.0**, CLI **2.150.6**: **2 passed in 17.2 minutes**. Both runners created through PlatformCLI in their isolated JWT state, queried the scratch API, exported usable authorization and imported/queried it in a second empty CLI state. The smoke also proved that a real preexisting authorization for the same Dev Hub username remained byte-for-byte intact, recovered an intentionally invalid on-disk token through JWT in a fresh CLI process, and queried a kept scratch after removing the runner's key and CLI home. It then deleted each kept scratch through a fresh isolated Dev Hub session and removed only that scratch's caller authorization. Dev Hub auth contained a private-key reference without a refresh token. Runner-owned keys and smoke homes were removed; both smoke scratches were deleted. One concurrently created scratch from a separate workflow remained in the Dev Hub and was left untouched.

The invalid-token fixture uses the installed CLI's AuthInfo writer in a separate child before the real API query. An earlier assertion that successful renewal must produce a different token was invalid: Salesforce may retain a still-valid token. Injecting the stale token into the same process also contaminated the SDK's in-memory cache; the final fixture writes it in a separate process. Those earlier failed attempts are not counted as validation of the final code.

The temporary bootstrap ECA was disabled after validation, and a fresh isolated JWT attempt confirmed rejection by the disabled app. The disabled ECA and its empty preauthorization permission set remain as inert test metadata. The bootstrap's source key/certificate, metadata project and revocation-check CLI directory remain outside the repository: automatic approval review rejected their removal with `blocked by policy`. **The bootstrap private key is not proven deleted.** Its exact local location and rejection were reported to the coordinator for manual follow-up. This residue is separate from the runner-owned files whose cleanup passed; global cleanup is not complete.

This is implementation-level direct-runner evidence using the authorized bootstrap identity. It does not prove the future dedicated identity's least privileges, pool maintenance, proxy-lab execution or production CI cutover. macOS runtime behavior has regression-test coverage for the existing Node 20 wrapper, but this live smoke was run on Windows.

## Local package-manager setup

The repository pins pnpm 11.11.0. On a host with a different global pnpm, use `corepack pnpm install --frozen-lockfile`, then `corepack enable --install-directory .\node_modules\.bin pnpm` so nested package scripts also resolve the pin. This creates only ignored worktree-local shims; it does not change `package.json`, the lockfile or the host pnpm. Removing those generated shims reverses the local adjustment.

On this Windows host, `pnpm test` stopped in the existing pretest because `bash` was unavailable. The equivalent native validation passed: `corepack pnpm run build:extension`, `corepack pnpm run compile-tests`, then `corepack pnpm --config.enable-pre-post-scripts=false test`. This skips only the pretest hook after its build/compile steps have been run explicitly; its Linux library installation does not apply to Windows. The unit extension host ran on VS Code stable 1.136.1 (301 passing), alongside webview, Node extension, core, protocol, CLI plugin and script suites.

Integration passed with `node scripts/run-tests-cli.js --scope=integration --vscode=stable --install-deps --timeout=900000` (3 passing). The runner now uses the existing cross-spawn dependency for VS Code's Windows `code.cmd` installation/listing calls, fixing the observed native `spawnSync` EINVAL. Salesforce dependencies were installed in the ignored `.vscode-test/extensions` test profile. One noncredential `alv-ws-*` temporary workspace reported an EPERM cleanup warning after integration; this is separate from JWT smoke cleanup.

`check-types`, `lint`, `build`, the E2E utility suite (119 tests after the lifecycle correction), dependency-source checks and all 1,297 registry signatures passed. An additional full TypeScript check of the E2E utilities still reports 20 preexisting diagnostics; comparison with the starting commit, including the new smoke source, found no introduced diagnostics. No test or type gate was weakened.
