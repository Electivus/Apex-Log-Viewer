# Dedicated Dev Hub identity bootstrap

The operator commands prepare the dedicated `apex-log-viewer-ci@electivus.com` identity, minimum runtime grants and certificate-backed External Client App (ECA). The administrator performs discovery, user/license changes and metadata deployment. The native proof starts from empty Salesforce CLI homes under the dedicated user, independently of `devhub-auth.js` and the application's runners.

## Current evidence and prerequisites

**The dedicated identity is not yet provisioned or proven in a live org.** On 7 September 2026, discovery verified the authorized target, available Integration and Salesforce capacity, minimum profiles, Integration permission set license and unrelated pools/scratch resources. User creation rolled back because the existing `SDO_Tool_SalesforceRewind_User` trigger depends on an invalid handler: local `JSON` and `DmlException` classes shadow native Apex types. A separate seven-reference qualification proposal was prepared for owner approval. This workflow neither modifies nor bypasses that component. Its check-only compilation passed but reported **zero tests executed**. No dedicated user, assignment, app or live credential was created by the attempted bootstrap; this trigger failure does not establish Integration incompatibility.

Scoped validation of `ALV_ScratchOrgPoolService`, including `ScratchOrgInfo.Create`, passed check-only deployment; it was not applied. Effective user grants, metadata acceptance for the new ECA, native JWT/scratch/pool behavior and permanent provisioning remain unverified. Earlier administrator-based feasibility/runner results are separate evidence.

Permanent storage and certificate validity still require the operator's decision. There is no default lifetime. A temporary proof uses explicit `temporary`, at most two days and `temporary-local`; it does not count as permanent provisioning or CI cutover.

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

Fallback rechecks Salesforce capacity, removes the owned runtime assignment and Integration permission set license, and changes the same user to **Minimum Access - Salesforce**. A saved pending transition reconciles uncertain updates. Unexpected permission set licenses are preserved and cause a stop. Runtime grants must be assigned/audited afterward. Inspect sanitized `integrationFailure`, `fallback` and `runtime` evidence; do not manufacture evidence or switch licenses to circumvent the trigger. The final supported license remains pending live proof.

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

Intended policy: `Api,RefreshToken`, `AdminApprovedPreAuthorized`, explicit permission-set API-name preauthorization, `Enforce` IP restrictions, zero refresh-token lifetime and a 15-minute session. Retrieval verifies the active fingerprint/scopes/policy. Only the owned user may hold its preauthorization permission set. API names and source suffixes follow the feasibility-tested metadata model; the new app still needs live validation.

Retrieved global OAuth metadata can contain a consumer secret. The private tree also contains `jwt-inputs.json` with the client ID, username, login URL and key-file reference. Never print or publish this tree, raw/verbose CLI output, keys, tokens, auth URLs or lease tokens. Public output and `identity.json` retain sanitized outcomes and file references. Native errors expose recognized categories only; privately diagnose an unclassified failure instead of interpreting it as license incompatibility.

For **permanent** generation and provisioning, first obtain the operator's decision. Supply `--credential-mode permanent --certificate-days <approved days> --storage-policy <approved storage> --policy-reference <approval reference>` to both commands, with `credentials-permanent` paths. The reference records actual approval; the script cannot authenticate it or create a secret store. Transfer to the approved store and production workflow cutover are separate #1078 operations. Rotation of the active CI identity belongs to #1079. Do not infer approval from examples, ready labels or elapsed time.

## Independent native proof

```powershell
node scripts/devhub-identity.js prove @identityArgs --credential-mode temporary --pool-mode definition
```

The proof creates one unique pool, one slot and one one-day scratch. Native `sf org login jwt` starts in an empty home and API queries confirm the intended org/user. It acquires a lease, creates through **PlatformCLI**, queries/privately exports the scratch, imports/queries in a second empty home, finalizes/heartbeats/releases the lease, disables and verifies the owned slot through the runtime data API, then deletes the active scratch and pool/slot records. Parent administrator auth is never copied. `SF_TEMP_SHOW_SECRETS=true` is scoped to export; PlatformCLI overrides are scoped to scratch creation.

Redacted/malformed export, identity mismatch, unexpected lease results or pool mode fail the proof. For an explicitly selected snapshot mode, use `--pool-mode snapshot --snapshot-name <authorized snapshot>`. Entitlement/ownership errors retain their actual phase; modes and shared pools are not changed to make a proof pass. A definition-mode pass cannot establish snapshot support. Existing pool-administration concurrency remains its established contract; this native proof independently checks REST/data permission access.

Cleanup reconciles unique pool/slot tags on `ScratchOrgInfo`, verifies creating user and active scratch owner, and deletes only owned resources. Pending signup, owner mismatch or denied deletion retains recovery state and fails. Historical signup records remain after active scratch deletion and are reported by noncredential ID. Other scratches/pools remain untouched. For old shared scratches, have their existing owner/admin drain/delete the specified resources before reconciliation and prewarm under the new identity; never clear credentials or broaden runtime rights to bypass ownership. See [ownership transition](DEVHUB_JWT.md#ownership-transition).

`proof-passed` requires all native assertions and remote cleanup. It does not establish permanent provisioning, snapshot support, CI execution or local credential deletion. The ledger retains every attempt and reports private directories. Unconfirmed cleanup blocks another proof until recovery.

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

Local validation on **7 September 2026 UTC**, Windows 11 / Node 24.19.0 / pnpm 11.11.0, passed: 23 new command tests, 126 E2E utility tests, `check-types`, `lint`, `build`, the Windows-native `pnpm test` equivalent (including 327 script tests, 105 webview tests and 301 VS Code stable 1.136.1 unit tests), all 3 stable integration tests, dependency provenance and all 1,297 registry signatures. As documented in [DEVHUB_JWT.md](DEVHUB_JWT.md#local-package-manager-setup), build/compile pretest steps ran explicitly before disabling the Linux-only pretest hook for Windows. Integration emitted dependency/listener warnings and the existing noncredential temporary-workspace EPERM cleanup warning; its tests passed. These checks do not remove the live identity/trigger and permanent-policy blockers above.

The consolidated review fix passed **26 command tests**, including real Windows ACL replacement/rejection and the CLI's REST transport envelope. Salesforce CLI 2.150.6 also accepted an `@`-prefixed body file in an actual read-only composite API request and returned HTTP 200 with the payload under `result.body`. That transport check used the existing bootstrap login; it is not dedicated-identity permission proof. Passing unchanged broad suites were not repeated after these isolated script fixes.
