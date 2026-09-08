# Dev Hub JWT validation

For dedicated-user discovery, explicit certificate policy, minimum grants and independent native proof, see [Dev Hub identity bootstrap](DEVHUB_IDENTITY.md). Its live provisioning/permission evidence is tracked separately from the bootstrap-identity runner results below.

The integrated contract covers direct runners (#1074), pool administration/consumption (#1075), proxy transport (#1076), the dedicated identity (#1077) and production workflow cutover (#1078). Historical smoke results below retain their original identities and limits; they are not production CI evidence. [Production workflow cutover](#production-workflow-cutover) records the current procedure and acceptance.

## Configuration

The JavaScript runner (`scripts/run-tests.js`), TypeScript E2E runner (`ensureScratchOrg`) and administrative commands (`scripts/scratch-pool-admin.js`) use `scripts/devhub-auth.js` through their existing Salesforce CLI adapters.

| Variable                     | Meaning                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `SF_DEVHUB_CLIENT_ID`        | ECA consumer key                                                               |
| `SF_DEVHUB_USERNAME`         | Explicit Salesforce username to authenticate                                   |
| `SF_DEVHUB_LOGIN_URL`        | HTTPS login origin, such as `https://login.salesforce.com`                     |
| `SF_DEVHUB_PRIVATE_KEY_FILE` | Path to a readable, unencrypted RSA PEM private key, at least 2048 bits        |
| `SF_DEVHUB_PRIVATE_KEY`      | Alternative inline PEM; supply exactly one of the two key inputs               |
| `SF_DEVHUB_ALIAS`            | Explicit, already authenticated local alias, available only when JWT is absent |

Any JWT input selects JWT. Partial, malformed or rejected JWT configuration fails without trying an alias, a default identity or an authorization URL. CI requires complete JWT even when a cached alias or `SF_DEVHUB_AUTH_URL` exists. Neither `SF_DEVHUB_AUTH_URL` nor `SFDX_AUTH_URL` is an authentication fallback.

JWT uses the configured username as the target identifier. It does not change the global default Dev Hub or repoint a supplied alias. With an inline key, this username is resolved only in the workflow-owned CLI home. The ECA must already allow certificate-backed login for that user. The approved permanent identity, GitHub repository Secret storage and 365-day certificate are recorded in [DEVHUB_IDENTITY.md](DEVHUB_IDENTITY.md).

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

Salesforce CLI **2.150.6** is the version proven by the direct smoke below. To prepare that exact version in the existing cache, use `node scripts/setup-salesforce-cli.mjs --package @salesforce/cli@2.150.6`, then point `SF_CLI_BIN_PATH` at its Salesforce CLI executable. `ALV_SF_BIN_PATH` is also recognized. Windows npm `.cmd` resolution is preserved, including configured paths with spaces. Keep the existing macOS Node 20 wrapper from `setup-salesforce-cli.mjs`; point the binary variables at that wrapper instead of bypassing it. Production real-org jobs pin this exact CLI version; the macOS CLI runtime remains Node 20 while application builds use Node 24.

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

## Pool maintenance and independent consumers

All six existing administrative commands authenticate before reading or mutating a pool: `bootstrap`, `list`, `reconcile`, `prewarm`, `disable-slot` and `reset-slot`. Set the JWT variables above, then select the pool explicitly:

```powershell
pnpm run scratch-pool:list -- --pool-key '<configured pool>' --json
pnpm run scratch-pool:reconcile -- --pool-key '<configured pool>'
pnpm run scratch-pool:prewarm -- --pool-key '<configured pool>' --limit 1
```

`--target-org <alias>` is an explicit local alias alternative only when all JWT inputs are absent. It cannot override a selected JWT identity or make an alias valid in CI. `list` omits scratch authorization URLs and lease tokens even with `--json`.

Prewarm still uses the conditional slot update to acquire its maintenance lease. The scratch is created with PlatformCLI, its usable authorization is handed to the caller through CLI export/import, and the existing `ScratchAuthUrl__c` field receives the same authorization URL format. Reconciliation marks redaction placeholders or unusable URLs as requiring recreation. No schema, lease API, credential format or cache layout changes are required.

An independent consumer uses `SF_SCRATCH_STRATEGY=pool` and `SF_SCRATCH_POOL_NAME=<configured pool>` with the same JWT inputs. It imports the stored scratch authorization through the CLI. Pool REST calls retain their originating JWT home and can renew authentication once after HTTP 401, including acquisition, heartbeat, finalization, release and owned-scratch deletion. Cleanup stops and drains an in-flight heartbeat before releasing the lease and removing the owned JWT key/state.

### Ownership transition

Before replacing an identity, inspect the configured pool's `ScratchUsername__c`, `ScratchOrgInfoId__c` and `ActiveScratchOrgId__c`, and establish who owns those resources. Drain existing leases before maintenance. If deletion returns `INSUFFICIENT_ACCESS`, the command reports that the existing owner or administrator must delete that scratch; it does not create a replacement or clear the only stored credential. Failed prewarm returns the slot to `available` with `needs_recreate`; a failed consumer deletion releases a recoverable `broken` slot with the prior credential retained. Do not repeatedly prewarm it under an identity that lacks deletion access.

Have the existing owner or administrator finish and delete those specific old scratches during the transition, then reconcile and prewarm the affected pool under the intended identity. Do not reset a live pool, clear credentials before confirmed deletion, or expand the runtime identity's privileges to avoid this ownership step. A lost conditional maintenance race or HTTP 409 lease conflict remains a conflict, not a reason to overwrite another lease.

The controlled validation below used the previously authorized bootstrap identity. Deletion of its own scratch was observed. Deletion denial for an administrator-owned scratch was exercised at the REST boundary with the actual Salesforce error code; no unrelated administrator-owned scratch was deleted or mutated. The [dedicated Integration identity proof](DEVHUB_IDENTITY.md#live-1077-result-and-retained-resources) subsequently passed its own scratch lifecycle and pool REST/data operations in #1077. Transition of existing-owner resources and production cutover remain #1078 responsibilities.

### Controlled pool validation

With an authorized Dev Hub, complete **inline** JWT inputs and available scratch capacity, run:

```powershell
$env:ALV_POOL_JWT_SMOKE = '1'
$env:ALV_JWT_SMOKE_DEVHUB_ORG_ID = '<verified authorized Dev Hub org ID>'
node scripts/run-playwright-cli-e2e.js test/e2e/cli/poolJwt.e2e.spec.ts --workers=1 --retries=0 --reporter=list --output=apexlogs/pool-jwt-smoke-results
```

The parent creates a unique pool with two logical slots and only **one one-day scratch**. The empty first slot is disabled; the second is prewarmed and consumed. The existing shrink operation later deletes that scratch, after which the smoke removes only its own pool/slot records. A separate Playwright process starts with empty CLI state and exercises import, scratch query, a real 401 followed by JWT renewal and a successful heartbeat, finalization, successful release, and a second lease released with a controlled failure. The parent verifies recovery through `list`/`reconcile` and cleans up. The consumer-only test is skipped in the parent and runs in the child; that expected skip is not a skipped acceptance gate.

Observed on **2026-09-06** (America/Bahia), Windows 11, Node **24.19.0**, Salesforce CLI **2.150.6**: parent lifecycle **passed in 23.8 minutes**, including the passing independent consumer. Dev Hub auth had a private-key reference with no refresh token; the imported scratch used a PlatformCLI refresh token with no private key. The successful smoke removed its scratch, both slot records, pool, and temporary CLI homes. One unrelated active scratch remained before and after. Sanitized local evidence is written to ignored `apexlogs/pool-jwt-smoke-evidence.json`.

Two earlier attempts exposed a CLI stdout/stderr diagnostic issue and smoke timing/inventory assumptions. Their scratchs and isolated pool records were subsequently deleted through JWT. The final code tolerates the current CLI's `NoAuthFoundForTargetOrgError` on already-absent local authorization, even when stderr contains unrelated warnings. The smoke starts its heartbeat observation timeout after import, and recognizes scratch authorization in either CLI inventory category.

The temporary ECA `ALV_1075_JWT_20260907` was disabled after validation; a fresh JWT login in an empty home was rejected specifically because the app was disabled. Its temporary preauthorization assignment was removed. The disabled ECA, its generated policies/global settings and the empty `ALV_1075_JWT_PreAuth` permission set remain as inert metadata. Automatic approval review rejected removal of the bootstrap private key and the first failed smoke's local directory with `blocked by policy`; those removals were not retried by another mechanism. **The bootstrap private key is not proven deleted.** The bootstrap directory and both failed-attempt directories remain outside the repository and were reported by exact path to the coordinator for manual follow-up. This retained local state is distinct from the successful smoke's verified cleanup. Do not reactivate that test ECA. The #1074 residue was neither reused nor altered.

The #1075 local gates passed: 126 E2E utility tests, 70 focused admin/shared-auth/runner tests, `check-types`, `lint`, `build`, and the Windows-native `pnpm test` equivalent below, including 295 script tests and 301 VS Code unit tests. The stable 1.136.1 integration host passed all 3 tests. Dependency provenance and all 1,297 registry signatures passed. A full E2E TypeScript comparison against the starting commit included both smoke sources and found the same 20 preexisting diagnostics, with none introduced. Integration again reported a noncredential temporary-workspace EPERM cleanup warning; no validation gate was weakened.

## Local package-manager setup

The repository pins pnpm 11.11.0. On a host with a different global pnpm, use `corepack pnpm install --frozen-lockfile`, then `corepack enable --install-directory .\node_modules\.bin pnpm` so nested package scripts also resolve the pin. This creates only ignored worktree-local shims; it does not change `package.json`, the lockfile or the host pnpm. Removing those generated shims reverses the local adjustment.

On this Windows host, `pnpm test` stopped in the existing pretest because `bash` was unavailable. The equivalent native validation passed: `corepack pnpm run build:extension`, `corepack pnpm run compile-tests`, then `corepack pnpm --config.enable-pre-post-scripts=false test`. This skips only the pretest hook after its build/compile steps have been run explicitly; its Linux library installation does not apply to Windows. The unit extension host ran on VS Code stable 1.136.1 (301 passing), alongside webview, Node extension, core, protocol, CLI plugin and script suites.

Integration passed with `node scripts/run-tests-cli.js --scope=integration --vscode=stable --install-deps --timeout=900000` (3 passing). The runner now uses the existing cross-spawn dependency for VS Code's Windows `code.cmd` installation/listing calls, fixing the observed native `spawnSync` EINVAL. Salesforce dependencies were installed in the ignored `.vscode-test/extensions` test profile. One noncredential `alv-ws-*` temporary workspace reported an EPERM cleanup warning after integration; this is separate from JWT smoke cleanup.

`check-types`, `lint`, `build`, the E2E utility suite (119 tests after the lifecycle correction), dependency-source checks and all 1,297 registry signatures passed. An additional full TypeScript check of the E2E utilities still reports 20 preexisting diagnostics; comparison with the starting commit, including the new smoke source, found no introduced diagnostics. No test or type gate was weakened.

## Isolated corporate proxy-lab validation

The lab uses the same strict policy at the host entry point, container preflight and real child runner. Supply `SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_LOGIN_URL` and exactly one of `SF_DEVHUB_PRIVATE_KEY` (inline PEM) or `SF_DEVHUB_PRIVATE_KEY_FILE` (caller-owned path). Use the verified authorized Dev Hub identity. Neither an authenticated host alias nor a legacy Dev Hub URL is accepted as a fallback. Explicit non-org commands run without these inputs:

```powershell
$env:DOCKER = 'podman' # Omit when using Docker.
$env:COMPOSE_PROJECT_NAME = 'alv-jwt-validation'
pnpm run test:e2e:proxy-lab -- node --version
```

With the JWT variables already configured as in [TESTING.md](TESTING.md#corporate-proxy-lab), reproduce the controlled direct smoke with:

```powershell
$env:SF_SCRATCH_STRATEGY = 'single'
Remove-Item Env:SF_SCRATCH_POOL_NAME -ErrorAction SilentlyContinue
$env:SF_TEST_KEEP_ORG = '0'
$env:ALV_DEVHUB_JWT_SMOKE = '1'
$env:ALV_JWT_SMOKE_DEVHUB_ORG_ID = '<verified authorized Dev Hub org ID>'
node scripts/run-e2e-proxy-lab.js -- node scripts/run-playwright-cli-e2e.js test/e2e/cli/devhubJwt.e2e.spec.ts --grep typescript --workers=1 --retries=0 --reporter=list --output=apexlogs/proxy-jwt-smoke-results
```

### Transport, lifetime and recovery

The host validates inputs before invoking the engine, copies them into a private temporary directory outside the repository, and mounts only its `input` directory read-only at `/run/alv-devhub`. A generated Compose override contains paths, never credential values. Build contexts are limited to `test/e2e/proxy-lab` with an allowlist; image layers receive no JWT material. Compose's environment excludes JWT values, host aliases, legacy URLs, secret-output flags and global signup-client overrides.

An exclusive `alv-proxy-lab-jwt-<uuid>` native Linux volume holds `/run/alv-state`. The child isolates its home and temporary directories there, authenticates preflight through the existing CLI adapter, then runs the requested command with the same policy. Dev Hub key/state survives all dependent scratch operations and renewal. The direct runner alone selects PlatformCLI for scratch creation/export. `CI=true` is consistent during pnpm installation and child execution; CLI auth directories are never reusable cache mounts.

On normal success or failure, child state, volume, copied input and generated override are removed. If teardown retains scratch recovery state, the child is interrupted, or removal fails, the command exits unsuccessfully and reports the owned volume/directory. The host prints the operation report location before starting Compose; `report/operation.json` maps it to its unique volume. `recovery-required` identifies the child directory; absence of `complete` means cleanup is unconfirmed. Recover only that execution's scratches using its retained home/key, then remove its exact volume and report directory. Do not reset shared pools or delete another operation's resources. Force-killing the host can prevent its final cleanup; use the already printed report and remove the owned copied input after recovery. A denied removal must be reported and not retried through another mechanism. The original caller-owned key is never removed by the runner.

### Corporate trust and Windows setup

The runner retains proxy-only networking, proxy authentication, the negative test before trusting the lab CA, and positive curl/Node TLS checks afterward. For an upstream corporate inspector, the host reuses `SSL_CERT_FILE` or the explicitly selected `ALV_E2E_PROXY_LAB_UPSTREAM_CA_FILE`. The proxy mounts that approved bundle read-only and combines it with its existing system roots. Unset the explicit variable to revert selection; no host certificate store is changed. No TLS verification or package-signature checks are disabled.

On the tested user-scope Podman 6.1.1 / podman-compose 1.6.0 setup, the provider interpreted a Windows drive path as a Git URL. [repair-podman-compose-windows.ps1](../scripts/repair-podman-compose-windows.ps1) applies the narrow drive-path check to the existing uv-managed provider, preserves its module in `podman_compose.py.alv1076-backup`, and checks Windows paths/Git URLs in a fresh Python process. It refuses unsupported layouts or conflicting backups. Run it with `-Undo` to restore that exact backup. The installed module is under the directory returned by `uv tool dir`, at `podman-compose\Lib\site-packages\podman_compose.py`. No elevation or engine reinstall was needed. Both actual Compose execution and this fresh-process check verified the repair.

### Observed evidence (#1076)

On **2026-09-07 UTC**, the isolated proxy lab passed the direct TypeScript lifecycle smoke in **1.6 minutes** with container Node **24.15.0**, Salesforce CLI **2.150.6**, pnpm **11.11.0**, using the authorized temporary bootstrap identity. All proxy/TLS negative and positive controls passed. Empty-state JWT, Dev Hub state without a refresh token, renewal after a deliberately stale access token, scratch API access, independent scratch credential import/query, keep-org usability after Dev Hub cleanup and final owned-scratch deletion were observed. Preexisting same-username state remained intact. Host input directories and operation volumes were absent afterward. The final Dev Hub inventory matched the original unrelated scratch; no shared pool was acquired or modified.

Earlier attempts exposed native permission requirements for CLI secret state and two Linux-only test-fixture assumptions. Native volumes resolved the permissions failure. Updating `process.env` in place keeps Node's native Linux temporary-directory lookup synchronized; resolving the CLI symlink before loading its AuthInfo writer fixes the renewal fixture. The earlier scratches were deleted and those failed attempts do not count as acceptance. The successful lab proof uses the existing direct runner, not a host substitute.

The temporary ECA `ALV_1076_JWT_20260907` was disabled after the proof with a scoped validated deployment. A fresh JWT login from empty CLI state was rejected specifically because the app was disabled, and its temporary preauthorization assignment was removed. Disabled app/policy/global metadata and the empty `ALV_1076_JWT_PreAuth` remain inert. Automatic approval review rejected deletion of the bootstrap directory with `blocked by policy`. **Its private key is not proven deleted.** The key/certificate, metadata (including consumer secret) and revocation-check state remain outside the repository and their exact location was reported to the coordinator for manual cleanup; removal was not retried. This is separate from the verified per-execution cleanup. Do not reactivate the temporary app or reuse previous tickets' residue.

This proof does not establish the future dedicated user's least privileges or production CI cutover; those remain later tickets. Production workflows were not changed by this slice.

Final local gates passed: 33 proxy-lab boundary tests, 126 E2E utility tests, `check-types`, `lint`, the Windows-native `pnpm test` equivalent (including 302 script tests and 301 stable VS Code unit tests), the 3 stable integration tests, dependency provenance and all 1,297 registry signatures. The credential-free container smoke also passed after the final mount changes. Integration reported the existing noncredential `alv-ws-*` EPERM cleanup warning.

The first Windows build exposed Linux links written into package-level `node_modules` through the workspace bind mount. The lab now gives each package its own dependency volume as well as the root volume. `pnpm install --force --frozen-lockfile` did not repair the existing host links; automatic approval review rejected removing those generated package dependency directories with `blocked by policy`. They were preserved for manual repair. A fresh Windows validation worktree containing the same complete source changes installed the frozen dependencies and passed `pnpm run build`. The failed original build is recorded as a host dependency limitation, not a passing gate in that checkout. No blocked removal was retried by another mechanism.

The independent Standards and Spec reviews both identified the direct-runner command-selection mismatch (ST-001/SP-001): integration/CI entry points, nonempty `SF_SETUP_SCRATCH` values and JWT-only opt-in must preserve the runner's existing semantics. The correction shares `requiresScratchSetup` with that runner, recognizes its published integration commands/scopes, and derives the container decision from mounted JWT inputs. Unit/VSIX commands remain credential-free. The affected follow-up validation passed 69 lab/direct-runner tests (including 35 lab tests), 126 E2E utility tests and `check-types`; the earlier broad gates were not repeated for unchanged behavior.


## Production workflow cutover

The operator approved repository GitHub Actions Secrets and a 365-day certificate on 7 September 2026. The four stored inputs are `SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_LOGIN_URL` and `SF_DEVHUB_PRIVATE_KEY`; the runtime username is `apex-log-viewer-ci@electivus.com`. Electivus repository maintainers own CI configuration and the Dev Hub administrator owns user/ECA grants and owner-scoped scratch retirement. The certificate expires on 7 September 2027 at 11:34:01 UTC; rotation and interrupted-replacement recovery belong to #1079.

All three real-org jobs validate the actual JWT and pool configuration through `node scripts/check-real-org-config.js`. They pass the same four inputs to the CLI, native Kotlin harness and extension runners. The proxy host copies them into its private operation mount; container preflight and child enforce the same policy. Telemetry preparation/query-only steps need no Salesforce credentials; the emitting extension run receives complete JWT. The main-required E2E, security and quality gates remain enforced.

### Operator verification and retirement

1. Inspect the configured pool and scratch ownership before starting consumers. Drain live leases through their owners. If an old scratch remains active, have its existing owner/admin delete that exact resource; retain stored credentials until deletion is confirmed. Never reset a live pool or broaden runtime grants to evade ownership.
2. Check Secret names/timestamps with `gh secret list --repo Electivus/Apex-Log-Viewer --json name,updatedAt`. This cannot read values or prove a runner login. Supply the approved inputs privately when running `node scripts/check-real-org-config.js` locally, with `SF_SCRATCH_POOL_NAME` set.
3. Dispatch the candidate with `gh workflow run e2e-playwright.yml --repo Electivus/Apex-Log-Viewer --ref <reviewed-branch> -f jwt_smoke_devhub_org_id=<verified-authorized-org-id>`. Verify actual direct, pool, proxy and telemetry results at the exact candidate SHA. The controlled smokes create/delete their own scratches and verify independent credential import; expected pre-cutover failures never count as success.
4. Merge only the reviewed, passing candidate. Dispatch the same workflow at the integrated `main` commit and verify its actual results before closing #1078. Record exact source/merge SHAs, run URLs, platforms, retries and cleanup in the issue evidence.
5. Inventory remaining legacy references with `git grep -n SF_DEVHUB_AUTH_URL`. No workflow reads or propagates the old secret. Remaining references document rejection, tests, historical evidence or the direct runner's legacy opt-in signal, which still fails strict JWT selection. The unused GitHub Secret is retained pending owner-controlled retirement; it cannot authenticate these workflows. Do not revoke a personal refresh token or another consumer's session to prove independence.

### Transition observation and recovery

On 8 September 2026, a fresh Windows Node 24.19.0 / Salesforce CLI 2.150.6 process authenticated the dedicated identity and verified its expected Dev Hub/user IDs. The configured `alv-e2e` pool retained its 30 slots, definition mode, baseline and lease settings. All 718 associated historical signups were already `Deleted`, and no active scratch belonged to that pool. One unrelated active scratch was preserved. The canonical JWT `reconcile` command completed for all 30 slots, marking each `needs_recreate` without resetting leases, clearing stored credentials or changing the pool definition. Consumers can provision/reuse slots under the new identity; no owner/admin deletion or privilege change was needed at this stage.

If JWT configuration fails, stop real-org work, check the four approved Secret inputs, ECA preauthorization, certificate and the expected identity, then rerun from clean CLI state. Recover via the existing permanent identity/operator files; do not restore legacy fallback or revoke/replace the active certificate as part of this cutover. If a workflow fails after signup, reconcile its exact scratch/lease using retained CLI state before deleting owned operation files. Keep usable shared-pool scratches for future runs and retain their stored authorization. Report retained operation directories/volumes and cleanup errors explicitly. Previously denied local removals remain separate unresolved residues and must not be retried by another mechanism.

Actual premerge and integrated-main CI acceptance is pending in #1078; the configuration checks and local identity observation above do not establish it.

Local cutover validation on 8 September 2026 passed Node 24.19.0/pnpm 11.11.0 type-check, lint, build, E2E utilities, dependency provenance, registry signatures and VS Code stable unit/integration checks. The Windows-native `pnpm test` sequence initially stopped at an obsolete security assertion expecting the old configurable CLI pin (420 of 421 script tests passed); the corrected pinned-version guard passed independently and the remaining unit-host/coverage steps completed. Passing unchanged script suites were not repeated. The first VS Code download lacked the current user's already-persisted `NODE_USE_SYSTEM_CA` and `NODE_EXTRA_CA_CERTS`; loading those approved settings into the invoking process and retrying from a fresh Node process passed. No persistent trust settings, roots or TLS verification were changed.
