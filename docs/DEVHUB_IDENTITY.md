# Dedicated Dev Hub identity bootstrap

The operator commands prepare the dedicated `apex-log-viewer-ci@electivus.com` identity, minimum runtime grants and certificate-backed External Client App (ECA). The administrator performs discovery, user/license changes and metadata deployment. The native proof starts from empty Salesforce CLI homes under the dedicated user, independently of `devhub-auth.js` and the application's runners.

## Current evidence and prerequisites

**The dedicated identity and permanent ECA passed the native definition-mode proof on 7 September 2026.** The user `apex-log-viewer-ci@electivus.com` uses **Salesforce Integration**, **Minimum Access - API Only Integrations**, and **Salesforce API Integration** (`SalesforceAPIIntegrationPsl`). No Salesforce fallback or general administrative grant was needed. A subsequent live rerun reconciled exactly one owned user and one owned app without creating duplicates; Integration capacity remained four free seats.

The original user-create blocker was repaired under the operator's explicit approval at **11:15:32 UTC**: six references became `System.JSON` and one became `System.DMLException` in the existing rewind handler. The trigger body and activation were preserved. The scoped deployment compiled; a separate native Apex test run executed **two tests, both passing, with 87% handler coverage**. The bootstrap script itself does not modify that component. The same approval selected repository GitHub Actions Secrets and a **365-day certificate**, valid from **7 September 2026 11:34:01 UTC** to **7 September 2027 11:34:01 UTC**. There is still no default certificate lifetime in the commands.

`ALV_ScratchOrgPoolService` was validated, deployed and assigned. Live audit confirmed scratch lifecycle permissions, all **36 field grants**, both pool Apex classes and no general administrative grants. The ECA metadata passed validation and retrieval checks for certificate, scopes, preauthorization, IP enforcement and token/session policy. The four approved `SF_DEVHUB_*` Secrets were stored and their names/update timestamps verified; GitHub does not return their values. Production workflows and the legacy secret remain unchanged: **#1078 owns cutover and #1079 owns rotation/recovery**. A temporary proof still requires explicit `temporary`, at most two days and `temporary-local`; it is not permanent provisioning.

Required tools: Node 24, the repository's pinned pnpm, Salesforce CLI **2.150.6**, and OpenSSL for certificate generation. On Windows 11 use PowerShell without elevation. Git for Windows commonly supplies OpenSSL under `$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe` or `C:\Program Files\Git\usr\bin\openssl.exe`. Select it with `--openssl <path>`. Preserve corporate proxy, CA trust, TLS and signatures.

Authenticate the authorized bootstrap administrator beforehand and supply the independently verified **18-character** target org ID on every remote operation. Use one private state directory outside the repository. Preserve `identity.json`: its UUID marker reconciles interrupted operations without adopting unrelated records. Private directories use current-user/SYSTEM ACLs on Windows and mode 0700/0600 elsewhere. No global Salesforce default, proxy setting or certificate store is changed.

Windows protection replaces the directory DACL with explicit current-user/SYSTEM full-control rules and verifies it, including certificate reruns. Descendants with unexpected principals or reparse points stop sensitive writes. It uses Windows PowerShell's .NET ACL APIs without loading modules from an inherited PowerShell 7 module path; no elevation or machine policy change is involved.

## Inspect and provision

Replace both placeholders and keep the same state directory throughout:

```powershell
$identityArgs = @('--target-org', '<authorized bootstrap alias>', '--expected-org-id', '<18-character authorized org ID>',
  '--state-dir', (Join-Path $env:LOCALAPPDATA 'ALV\devhub-identity'))
node scripts/devhub-identity.js inspect @identityArgs
node scripts/devhub-identity.js provision-user @identityArgs
```

`inspect` is read-only. Discovery reports live license capacity, minimum profiles, purpose-related users/apps, permission sets, scratch owners and pool modes; incomplete inventories stop the operation. Every mutation repeats target/ownership checks. The state lock prevents concurrent commands. After a terminated process, confirm its recorded PID is gone and reconcile the last operation before removing only `operation.lock`. Never discard the ledger to start over.

The first candidate uses **Salesforce Integration**, **Minimum Access - API Only Integrations**, and the live **SalesforceAPIIntegrationPsl** permission set license. Only the recorded `alv-devhub:<UUID>` user is reusable. The initial username/contact is `apex-log-viewer-ci@electivus.com`. An actual global duplicate chooses `apex-log-viewer-ci+<UUID>@electivus.com`, preserving the contact. An unrelated local user with that contact causes a stop. Exhausted capacity, a trigger error or transport failure never silently selects Salesforce.

## Runtime grants and explicit fallback

```powershell
node scripts/devhub-identity.js grant-runtime @identityArgs
```

This validates, then deploys only `ALV_ScratchOrgPoolService`, assigns it to the owned user and verifies its object permissions, every listed pool/slot and ScratchOrgInfo custom-field grant, both pool Apex class grants and the absence of general administrative permissions on the profile/assigned permission sets.

The source grants API access, read/create/edit/delete on both ALV pool objects and `ScratchOrgInfo`, and read/edit/delete on `ActiveScratchOrg`. Existing object-specific `View All` on scratch records and `Modify All` on the two pool objects are retained for maintenance. **General `View All Data`, `Modify All Data`, metadata administration, Apex authoring, user/profile/role administration and System Administrator are not assigned.** Read access does not establish deletion rights for another user's scratch.

Only a recorded, concrete Integration license restriction affecting `ScratchOrgInfo` or `ActiveScratchOrg` permits the explicit fallback:

```powershell
node scripts/devhub-identity.js use-salesforce-fallback @identityArgs
node scripts/devhub-identity.js grant-runtime @identityArgs
```

Fallback rechecks Salesforce capacity, removes the owned runtime assignment and Integration permission set license, and changes the same user to **Minimum Access - Salesforce**. A saved pending transition reconciles uncertain updates. Unexpected permission set licenses are preserved and cause a stop. Runtime grants must be assigned/audited afterward. Inspect sanitized `integrationFailure`, `fallback` and `runtime` evidence; do not manufacture evidence or switch licenses to circumvent the trigger. The live definition-mode proof supports the Integration license for this org and these operations; fallback remains an unexecuted, tested recovery path.

## Explicit certificate/ECA lifecycle

For the authorized temporary proof:

```powershell
$identityState = $identityArgs[-1]
$credentialArgs = @('--credential-mode', 'temporary', '--certificate-days', '2', '--storage-policy', 'temporary-local')
node scripts/devhub-identity.js create-certificate @identityArgs @credentialArgs --openssl '<OpenSSL executable>'
$keyFile = Join-Path $identityState 'credentials-temporary\private-key.pem'
$certificateFile = Join-Path $identityState 'credentials-temporary\certificate.pem'
node scripts/devhub-identity.js provision-app @identityArgs @credentialArgs --private-key-file $keyFile --certificate-file $certificateFile
```

Generation creates a 2048-bit RSA key and matching X.509 certificate. Reruns verify the explicit lifecycle/pair without overwriting them; incomplete generation is preserved for recovery. App names derive from the ownership UUID. Provisioning checks live descriptions/contact, records intent before writes and validates each metadata stage before applying it. OAuth starts disabled; the scoped policy then enables it. The command never creates a classic Connected App or reactivates a revoked app.

Verified live policy: `Api,RefreshToken`, `AdminApprovedPreAuthorized`, explicit permission-set API-name preauthorization, `Enforce` IP restrictions, zero refresh-token lifetime and a 15-minute session. Retrieval verifies the active fingerprint/scopes/policy and requires the client-credentials, guest-code-credentials and token-exchange flows to remain explicitly disabled; missing or enabled effective fields stop a rerun without silently rewriting policy. Only the owned user may hold its preauthorization permission set. The permanent app is `ALV_DevHub_69546c5387894093_CI`, and its sole-user preauthorization permission set is `ALV_DevHub_69546c5387894093_CI_Access`. API names and source suffixes were accepted by live metadata validation. Empty retrieval projects create their declared `force-app` package directory before calling the CLI.

Global OAuth verification also pins the localhost callback, required consumer secret, required refresh-token secret, disabled all-token introspection and disabled key/secret rotation requests. Salesforce's retrieved effective policy has **PKCE required**; generation now explicitly requests and verifies that stronger setting. These global fields must be present and match before `app-ready` is returned. JWT proof used this effective PKCE-required policy.

Retrieved global OAuth metadata can contain a consumer secret. The private tree also contains `jwt-inputs.json` with the client ID, username, login URL and key-file reference. Never print or publish this tree, raw/verbose CLI output, keys, tokens, auth URLs or lease tokens. Public output and `identity.json` retain sanitized outcomes and file references. Native errors expose recognized categories only; privately diagnose an unclassified failure instead of interpreting it as license incompatibility.

For **permanent** generation and provisioning, first obtain the operator's decision. Supply `--credential-mode permanent --certificate-days <approved days> --storage-policy <approved storage> --policy-reference <approval reference>` to both commands, with `credentials-permanent` paths. The reference records actual approval; the script cannot authenticate it or create a secret store. The approved run used `365` and `github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY`. Transfer to that approved store was completed in #1077; production workflow cutover remains #1078. Do not infer approval for another lifecycle from examples, ready labels or elapsed time.

After an approved permanent run passes, transfer the exact inputs through stdin, without echoing values or adding them to command arguments. Run from a private PowerShell session and stop on any failed upload:

```powershell
$jwtInputs = Get-Content -LiteralPath (Join-Path $identityState 'app-permanent\retrieved\jwt-inputs.json') -Raw | ConvertFrom-Json
$secretValues = @{
  SF_DEVHUB_PRIVATE_KEY = Get-Content -LiteralPath $jwtInputs.privateKeyFile -Raw
  SF_DEVHUB_CLIENT_ID = $jwtInputs.clientId
  SF_DEVHUB_USERNAME = $jwtInputs.username
  SF_DEVHUB_LOGIN_URL = $jwtInputs.loginUrl
}
foreach ($entry in $secretValues.GetEnumerator()) {
  $entry.Value | gh secret set $entry.Key --repo Electivus/Apex-Log-Viewer
  if ($LASTEXITCODE -ne 0) { throw "Secret upload failed: $($entry.Key)" }
}
gh secret list --repo Electivus/Apex-Log-Viewer --json name,updatedAt
Remove-Variable jwtInputs, secretValues
```

The verified certificate SHA-256 fingerprint is `FF:91:82:CC:32:01:74:71:D9:9B:51:10:11:2D:68:11:DA:1E:02:B7:48:19:C4:D9:20:A1:C5:5E:02:80:D3:4C`. Secret inventory confirms storage, not execution by a GitHub runner; that independent cutover gate is still required.

## Independent native proof

```powershell
node scripts/devhub-identity.js prove @identityArgs --credential-mode temporary --pool-mode definition
```

The proof creates one unique pool, one slot and one one-day scratch. Native `sf org login jwt` starts in an empty home and confirms the expected org ID; a runtime API query confirms the globally unique dedicated user ID. The minimum Integration profile rejects SOQL on `Organization` with `INVALID_TYPE`, so the Dev Hub check does not require that administrative query. Scratch org queries still verify `Organization` from their own separate identities. It acquires a lease, creates through **PlatformCLI**, queries/privately exports the scratch, imports/queries in a second empty home, finalizes/heartbeats/releases the lease, disables and verifies the owned slot through the runtime data API, then deletes the active scratch and pool/slot records. Parent administrator auth is never copied. `SF_TEMP_SHOW_SECRETS=true` is scoped to export; PlatformCLI overrides are scoped to scratch creation.

Redacted/malformed export, identity mismatch, unexpected lease results or pool mode fail the proof. For an explicitly selected snapshot mode, use `--pool-mode snapshot --snapshot-name <authorized snapshot>`. Entitlement/ownership errors retain their actual phase; modes and shared pools are not changed to make a proof pass. A definition-mode pass cannot establish snapshot support. Existing pool-administration concurrency remains its established contract; this native proof independently checks REST/data permission access.

Cleanup reconciles unique pool/slot tags on `ScratchOrgInfo`, verifies creating user and active scratch owner, and deletes only owned resources. Pending signup, owner mismatch or denied deletion retains recovery state and fails. If scratch creation was attempted but no signup is yet observable after a lost response, cleanup remains unconfirmed: retain runtime access and run `cleanup-proof` after the tagged signup becomes visible and terminal. App revocation and another proof remain blocked; absence alone cannot prove deletion. If no signup ever appears, preserve the ledger and obtain operator reconciliation rather than clearing its cleanup state. Historical signup records remain after active scratch deletion and are reported by noncredential ID. Other scratches/pools remain untouched. For old shared scratches, have their existing owner/admin drain/delete the specified resources before reconciliation and prewarm under the new identity; never clear credentials or broaden runtime rights to bypass ownership. See [ownership transition](DEVHUB_JWT.md#ownership-transition).

Proof intent starts in `initializing` with `remoteResourcesAttempted: false`, before directory creation and login. The marker is saved as true immediately before the first remote resource write. `cleanup-proof` can close a verified pre-resource attempt without CLI authentication, including an absent directory or partially prepared homes. Legacy `login` intent is also recoverable. Unknown phases, contradictory resource IDs, attempted writes, missing authentication after an attempt and incomplete inventories never establish cleanup. This releases later proof/revocation gates only when no resource write was attempted or owned deletion was reconciled.

Local definition preparation has its own `scratch-prepare` phase. The submission-attempt phase is saved only after the definition file is successfully written, immediately before invoking the CLI. A local write failure can therefore clean its owned pool without claiming an asynchronous request was sent.

`proof-passed` requires all native assertions and remote cleanup. It does not establish permanent provisioning, snapshot support, CI execution or local credential deletion. The ledger retains every attempt and reports private directories. Unconfirmed cleanup blocks another proof until recovery.

### Live #1077 result and retained resources

The permanent-app proof completed its assertions at **12:03:33 UTC** and remote cleanup at **12:06:30 UTC** on 7 September 2026. It passed JWT/API identity checks, owned PlatformCLI signup, scratch query/export, import/query from a second empty home, pool acquire/finalize/heartbeat/release, maintenance read/update, and owned scratch/slot/pool deletion. The final inventory found **zero active scratches owned by this identity**, one unrelated active scratch and the original four pools, all in `definition` mode. None of those unrelated resources was changed.

The same runtime identity's read-only query on `ScratchOrgSnapshot` returned **`INVALID_TYPE`**. This establishes unavailable snapshot API access under its actual current grants; it does not distinguish a missing grant from org/license entitlement and does not establish snapshot creation support. Snapshot mode was neither requested nor selected for the proof. Existing-owner/admin drain remains required before transitioning old scratch ownership; no deletion attempt was made against another owner's scratch.

The private operator state is retained under `%TEMP%\alv-1077-identity`: `identity.json` records ownership, assignments, deployment IDs and every proof attempt; `approved-storage-result.json` records Secret names/timestamps; `final-inventory-result.json` records the sanitized post-proof inventory. Retained sensitive directories are `credentials-permanent`, `app-permanent` and the two recorded `proof-<UUID>` directories. They contain the permanent key, retrieved OAuth metadata or CLI authorization state, have verified private ACLs, and must not be published. Remote test resources are gone; the historical signup record remains. The permanent user, PSL, runtime and ECA preauthorization assignments, ECA/policies and GitHub Secrets remain intentionally active for #1078. No temporary ECA was created in this slice. No new cleanup denial occurred; earlier policy-denied residuals from other slices remain untouched.

The preauthorization-only set is audited before assignment and on every `provision-app` rerun: every described `Permissions*` flag must be explicitly false, and every described grant relationship must be empty except exactly one `SetupEntityAccess` binding to the owned ECA. Assignment/session relations are checked separately or do not confer grants within the set. The set must be regular, unlicensed and require no activation. Missing schema/query results or any extra object, field, class, custom permission, tab or other entity grant stop acceptance without removing that access.

## Teardown/recovery

First resolve any pending scratch phase using the retained home, then reconcile remote cleanup. The first `cleanup-proof` retains CLI state while its app is active. Disable the temporary app and remove only owned local files:

```powershell
node scripts/devhub-identity.js cleanup-proof @identityArgs
node scripts/devhub-identity.js revoke-app @identityArgs --credential-mode temporary
node scripts/devhub-identity.js cleanup-proof @identityArgs
node scripts/devhub-identity.js cleanup-app-files @identityArgs --credential-mode temporary
```

Skip `cleanup-proof` if no proof was started. Revocation validates/deploys only the owned disabled policy, retrieves it to confirm, and attempts JWT from another empty home. `INVALID_CLIENT`/`INVALID_GRANT` record rejected authentication; transport/CLI failures remain explicitly **unverified**, and successful JWT after disablement requires investigation. Disabled app/policies, preauthorization permission set/assignment and the dedicated user remain identified in output/state for permanent setup or owner-controlled retirement. No unrelated or previous-experiment resources are removed.

Local app cleanup is restricted to a revoked **temporary** app. It removes generated metadata/revocation homes and matching certificate/key only at the exact generated paths under this identity's state directory; external caller-owned credentials are retained and reported. Permanent credentials cannot be removed by this command. Real-path containment precedes recursive deletion. Failures report the exact retained directory; never retry a policy-denied removal through another mechanism. Preserve the nonsecret ledger through handover.

To reverse runtime setup, drain/delete this identity's scratches and disable its ECAs first. The administrator can then remove its recorded permission-set assignments/license and deactivate this exact owned user. Do not delete/revert the shared permission set while other users depend on it. Reverting shared metadata or retiring permanent credentials requires its corresponding reviewed operational scope.

## Fast validation

```powershell
node --test scripts/devhub-identity.test.js
```

Public-command tests cover target/capacity guards, duplicate-safe resume, username collisions, lifecycle gates, effective grants, concrete license restrictions/interrupted fallback, app staging/preauthorization/revocation, two-home native lifecycle, bad exports/import failures and ownership-scoped cleanup. Mocked CLI success is not live minimum-license evidence. This suite also runs in `pnpm run test:scripts`; normal type/lint/build and Windows-native unit/integration checks apply.

Local validation on **7 September 2026 UTC**, Windows 11 / Node 24.19.0 / pnpm 11.11.0, passed: 23 initial command tests, 126 E2E utility tests, `check-types`, `lint`, `build`, the Windows-native `pnpm test` equivalent (including 327 script tests, 105 webview tests and 301 VS Code stable 1.136.1 unit tests), all 3 stable integration tests, dependency provenance and all 1,297 registry signatures. As documented in [DEVHUB_JWT.md](DEVHUB_JWT.md#local-package-manager-setup), build/compile pretest steps ran explicitly before disabling the Linux-only pretest hook for Windows. Integration emitted dependency/listener warnings and the existing noncredential temporary-workspace EPERM cleanup warning; its tests passed. Dedicated live acceptance is evidenced separately above.

Final affected validation passed **30 command tests**, covering actual Windows ACL replacement/rejection, native REST body-file/envelope semantics, retrieval package directories, the minimum profile's API limits, effective global/alternate OAuth controls, delayed signup visibility and local definition-write failure. The targeted regressions failed before their corrections and passed afterward. Fresh live ECA retrieval also passed all effective controls, with the same permanent app, assignment and certificate. The complete dedicated-identity lifecycle proof is recorded above; unchanged broad suites were not repeated after isolated script corrections.
