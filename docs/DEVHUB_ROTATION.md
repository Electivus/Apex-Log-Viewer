# Dev Hub certificate rotation and recovery

Use `scripts/devhub-identity.js` to replace the certificate on the existing owned permanent External Client App (ECA) and update its repository GitHub Actions private-key Secret. The commands retain the ECA/client ID, dedicated user, runtime permissions and Scratch Org Pool configuration. Administrator bootstrap access performs metadata work; fresh JWT verification uses the dedicated runtime identity.

## Ownership, policy and prerequisites

Electivus repository maintainers own the four GitHub Actions inputs and workflow validation. The authorized Dev Hub administrator owns ECA configuration. The Dev Hub Automation Identity remains `apex-log-viewer-ci@electivus.com`, using Salesforce Integration, its minimum API-only profile and existing audited grants. See [identity bootstrap](DEVHUB_IDENTITY.md) for the ownership marker and permission contract.

The approved policy for this installation is a **365-day certificate** and `github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY`. Every preparation requires explicit lifetime, storage policy and approval reference; there is no default lifetime. Another policy needs an operator decision. No reminder or recurring rotation is installed.

Before replacing an active credential:

1. Use Node 24, the pinned pnpm, Salesforce CLI **2.150.6**, OpenSSL and authenticated `gh`. Keep the repository-pinned CLI runtime and macOS isolation described in [CI.md](CI.md). On Windows 11 use PowerShell without elevation. Retain approved proxy/CA settings and TLS verification.
2. Authenticate the authorized bootstrap administrator and independently verify the exact **18-character** Dev Hub ID. For a normal rotation, retain the existing `identity.json` ownership UUID and history in [durable operator storage](DEVHUB_LOCAL.md). Do not adopt another similarly named app. If the original journal/key was lost, use the separate audited recovery procedure below.
3. Confirm the previous private key and certificate are readable, matching and unexpired. Preparation checks them and copies both into private recovery storage. **GitHub Actions Secrets cannot return an old key.** A successful Secret inventory query confirms names/timestamps only.
4. Resolve every owned proof's pending scratch/pool cleanup. Preserve shared pool leases, configuration and scratch authorization. Existing active scratches do not need deletion for a certificate rotation.
5. Schedule a quiet transition: inspect active real-org workflow runs and allow existing consumers to finish. A running/queued job may already hold the old Secret value; changing the store does not update that process. Do not reset its pool or revoke personal sessions to force the transition.

The supported metadata path has one effective `certificate` field on `ExtlClntAppGlobalOauthSettings`. Preparation performs a real dry-run of the narrow certificate update. It does not assume overlapping certificates or an atomic transaction spanning Salesforce and GitHub.

## Prepare the next certificate

Use an existing private durable state directory outside Git, temporary roots, synchronized folders and application caches, and a new, uniquely named candidate directory. Substitute verified values locally. Never put private material in command arguments, committed files, logs or CI artifacts.

```powershell
$identityState = '<existing private identity state directory>'
$candidateState = Join-Path $identityState 'rotation-input-<unique operation name>'
$identityArgs = @('--target-org', '<authorized bootstrap alias>',
  '--expected-org-id', '<verified 18-character Dev Hub ID>', '--state-dir', $identityState)
$policyArgs = @('--credential-mode', 'permanent', '--certificate-days', '365',
  '--storage-policy', 'github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY',
  '--policy-reference', '<actual operator approval reference>')

node scripts/devhub-identity.js create-certificate --state-dir $candidateState @policyArgs --openssl '<OpenSSL executable>'
if ($LASTEXITCODE -ne 0) { throw 'Candidate generation failed; preserve its directory.' }
$candidateFiles = Join-Path $candidateState 'credentials-permanent'
node scripts/devhub-identity.js prepare-rotation @identityArgs @policyArgs `
  --expected-fingerprint '<verified current SHA-256 certificate fingerprint>' `
  --certificate-file (Join-Path $candidateFiles 'certificate.pem') `
  --private-key-file (Join-Path $candidateFiles 'private-key.pem')
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed; active replacement is not authorized by this result.' }
```

`create-certificate` generates a fresh RSA-2048 key and X.509 certificate without overwriting a prior candidate. Check the reported `validFrom`, `validTo` and fingerprint. `prepare-rotation` rejects absent policy, unreadable/mismatched files, unsupported keys, expired/future certificates or a lifetime different from the explicit policy before remote writes. It rejects the unchanged certificate.

Preparation rechecks the owned user/app, recorded current fingerprint, effective OAuth controls, exclusive ECA preauthorization and complete runtime grant inventory. It verifies all four Secrets exist, copies the previous/candidate pairs into `rotation-<UUID>/{previous,candidate}`, then validates a deployment containing only the global OAuth certificate settings. It changes no active app, Secret or runtime grant. Record the returned `rotationId`, candidate fingerprint and expiry. Preserve all private input files, metadata and `identity.json`.

## Apply in order

```powershell
$rotationId = '<rotationId returned by preparation>'
node scripts/devhub-identity.js apply-rotation @identityArgs --rotation-id $rotationId
if ($LASTEXITCODE -ne 0) { throw 'Rotation needs explicit recovery; preserve private state.' }
```

The command revalidates current ownership, grants, ECA policy, key/certificate and store availability. On the initial transition it proves the previous key through a fresh CLI home before any active change. It then:

1. Records `app-update-pending`, dry-runs and applies only the ECA global certificate update.
2. Retrieves effective metadata and confirms the new fingerprint, unchanged client ID and unchanged OAuth controls.
3. Authenticates the dedicated user through JWT in another empty CLI home and verifies the expected org/user through login plus an API query.
4. Records `store-update-pending` and sends the replacement private key to `gh secret set SF_DEVHUB_PRIVATE_KEY` through stdin. The other three input values remain unchanged.
5. Records confirmed store delivery, updates the private JWT input reference and active app fingerprint, then marks the journal `applied`.

**Expected impact:** new logins or JWT renewal using the old key can fail between the ECA update and consumption of the new Secret. Existing access tokens may continue temporarily, but that is not an availability guarantee. There is no cross-system atomic commit. If the candidate login or store write fails, the command stops with its recorded phase; it never restores a Dev Hub authorization-URL fallback.

`rotation-applied` deliberately returns `ciVerified: false`. A local JWT success, write acknowledgement, timestamp or idempotent rerun cannot attest a GitHub runner. Complete the next section before accepting the rotation or retiring recovery material.

## Verify actual CI and pool continuity

Run the existing real-org workflow at the exact reviewed source and again at the final integrated `main` commit:

```powershell
gh workflow run e2e-playwright.yml --repo Electivus/Apex-Log-Viewer --ref '<reviewed branch or main>' `
  -f jwt_smoke_devhub_org_id='<verified authorized Dev Hub ID>'
```

Record the run ID, exact SHA, Secret update time, active certificate fingerprint and expiry. The opt-in enables the direct JavaScript/TypeScript lifecycle smokes on Windows/macOS and Linux/MITM, plus the isolated pool/independent-consumer smoke. Keep ordinary E2E and telemetry gates enabled. Inspect actual receipts: empty-state JWT, expected dedicated identity, PlatformCLI scratch creation, API use, usable export/import into another empty CLI home, lease lifecycle and owned cleanup. These paths must use the newly configured credential. Preserve the CLI/runtime pins and the macOS wrapper/home checks.

Compare the live shared pool's configuration/leases and unrelated scratch inventory before and after; do not interpret deletion of a test pool as global cleanup. Report retained directories, volumes and resources precisely. Report configured flaky retries and any separately authorized service retries. A telemetry query failure does not require repeating successful emitting/resource-creating jobs. See [DEVHUB_JWT.md](DEVHUB_JWT.md#production-workflow-cutover) for the existing workflow and recovery contracts.

## Recover an interruption

Keep the original ledger. Confirm the recorded lock PID, process start time and child processes before treating a lock as stale. Never kill a reused PID or remove a lock belonging to an active operation. If the process is gone, reconcile the operation's recorded phase and remove only its stale `operation.lock`. An unknown phase or ownership conflict needs operator reconciliation; do not edit it to a success state.

Select a direction explicitly:

```powershell
node scripts/devhub-identity.js recover-rotation @identityArgs --rotation-id $rotationId --recovery-direction forward
# Or, only with the previous matching and unexpired private pair retained:
node scripts/devhub-identity.js recover-rotation @identityArgs --rotation-id $rotationId --recovery-direction rollback
```

| Recorded phase                         | Recovery behavior                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preparing`                            | Local copying or validation did not finish. Rerun the same preparation inputs and preserve conflicting/incomplete files for diagnosis. No active update occurs in preparation. |
| `prepared`                             | Both pairs and dry-run are ready. Apply or explicitly select recovery.                                                                                                         |
| `app-update-pending`                   | The remote result may be unknown. Read current metadata. Only the recorded previous/candidate fingerprints are accepted; do not blindly deploy again.                          |
| `app-updated` / `store-update-pending` | Verify the selected pair and current metadata, prove fresh JWT, then write the matching Secret. A lost Secret response is safely rewritten; its value cannot be read back.     |
| `store-updated`                        | Delivery succeeded but local finalization may be incomplete. Reconcile the same operation; another identical Secret write is safe.                                             |
| `applied` / `rolled-back`              | The recorded local transition is complete. The matching command is idempotent after current metadata checks. Actual CI verification remains separate.                          |

Forward recovery needs the retained candidate pair and private JWT inputs. Rollback needs the retained previous pair, still matching and unexpired, and the same administrator/store access. Missing rollback material fails before app/store writes and explains that GitHub cannot return it. If the candidate remains valid, select forward recovery explicitly. If neither pair is usable or remote metadata has an unrecognized fingerprint/policy, preserve evidence and obtain a new operator-approved recovery plan; do not adopt another ECA, broaden permissions or fall back to a personal refresh token.

Pending rotation blocks unrelated identity mutations. The public-command tests inject failures before ECA replacement, after a successful ECA update with a lost response, before Secret writing and after a successful Secret write with a lost response. They prove forward recovery, rollback, missing-key rejection, mutation counts and unchanged grants/pool records. These are controlled boundary tests, not deliberate outages of active CI.

## Lost local key or journal

Loss of the original operator files requires forward recovery of the same identity. It is not a normal rotation with an available previous-key rollback. Confirm that no verified backup is available and retain the missing path as evidence; do not search arbitrary credential stores or infer an ownership UUID or historical phase.

Generate a new candidate using the approved permanent policy above in a separate durable candidate directory. Select a new, dedicated leaf for the recovery state; preparation creates it and copies the candidate inside it. An existing unrelated directory, including one containing only candidate files, is rejected before its permissions or contents change. Then prepare a plan using the verified current app name and public certificate fingerprint:

```powershell
$identityState = Join-Path $env:USERPROFILE '.electivus\apex-log-viewer\devhub-jwt'
# This path must not exist yet. If occupied, select a new unique durable leaf
# and keep using its explicit --state-dir for verification and test commands.
$identityArgs = @('--target-org', '<authorized bootstrap alias>',
  '--expected-org-id', '<verified Dev Hub ID>', '--state-dir', $identityState)
node scripts/devhub-identity.js prepare-lost-material-recovery @identityArgs @policyArgs `
  --expected-app-name '<verified existing ECA developer name>' `
  --expected-fingerprint '<verified currently active SHA-256 fingerprint>' `
  --lost-state-dir '<exact missing original state directory>' `
  --certificate-file '<durable candidate certificate>' --private-key-file '<durable candidate private key>'
if ($LASTEXITCODE -ne 0) { throw 'Preserve the audit/candidate and resolve the preparation failure.' }
```

Preparation records `recovery-preparation.json` only in its newly created private leaf. A failed preparation can reuse that leaf only when the marker matches the same org, app, fingerprints, missing-state path and explicit lifecycle inputs. Preserve incomplete roots without a readable matching marker and select a new leaf instead of adopting them. This local marker records the preparation request, not historical Salesforce ownership or approval for active replacement.

Preparation reads live user/ECA ownership markers, the minimum Integration profile and PSL, exclusive preauthorization, complete runtime grants, current ECA policies/client ID/certificate and the four Secret names/timestamps. It retains a private immutable `recovery-plan.json`, copies the candidate, and dry-runs only the certificate metadata update. It makes no active credential change and does not create `identity.json`. The receipt contains the exact plan SHA-256 and new recovery ID, with the old journal/key unavailable, historical phases and outstanding historical proof resources unknown, rollback unavailable and CI unverified.

Before applying, the operator must approve that concrete plan: current identity/assignment evidence, candidate fingerprint/expiry, target store, quiet transition window, expected interruption of old-key JWT renewal, forward-only recovery and subsequent validation. The preparation's policy reference records candidate preparation; it does not authorize active replacement. Recheck active workflow consumers and pool leases before the transition without resetting or deleting them.

```powershell
node scripts/devhub-identity.js apply-lost-material-recovery @identityArgs `
  --approved-plan-sha256 '<exact approved receipt SHA-256>' `
  --policy-reference '<actual approval for this active recovery>'
if ($LASTEXITCODE -ne 0) { throw 'Preserve recovery state; reconcile and resume the same approved plan.' }
node scripts/devhub-local.js verify --state-dir $identityState
```

Apply rechecks the approved plan, live ownership/client ID/assignments, effective grants and GitHub Secret timestamps. The client ID, username and login URL Secrets must retain their approved timestamps on every attempt. The private-key timestamp must also match until the journal records an attempted Secret write; later phases allow its timestamp to change because an interrupted delivery may already have succeeded. A mismatch stops active writes and requires reconciliation. User selection verifies the contact email and ownership marker while preserving the actual username, including a suffix assigned after a global username collision. Only then does apply start a new recovery journal using the ownership marker read from Salesforce. `recovery` records the loss and unknown history; `recoveredAt` and new rotation phases describe this recovery's actual operations. No old provisioning timestamp, completed proof or successful old-key login is invented.

The existing ordered transition updates the same ECA certificate, proves the candidate through fresh JWT/User API, then writes only `SF_DEVHUB_PRIVATE_KEY` and saves the new active file references. Use the same `apply-lost-material-recovery` command to resume an interrupted operation: an already observed candidate certificate is preserved and an uncertain Secret delivery is safely rewritten after fresh JWT. A completed operation does not repeat the writes. A mismatched plan/journal, changed ownership/client/assignments or unavailable candidate fails closed. Rollback to the lost key is rejected; if the candidate itself becomes unusable, preserve evidence and approve a new recovery plan.

This command's completion establishes the local credential transition only. Run the existing JWT/scratch/pool smoke and actual source/integrated-main CI separately. UI failures and skipped telemetry still block full acceptance.

## Private artifacts and retirement

The ledger contains ownership, phases, fingerprints, expiry and private file references. The private tree contains keys, candidate/rollback pairs, JWT inputs, retrieved metadata that can include a consumer secret, and any interrupted CLI homes. Do not publish or upload that tree. Normal JWT checks remove only their own empty-home verification state; a cleanup failure reports the exact retained directory.

Cleanup uses three bounded native filesystem retries for transient file locks. Persistent failure records a sanitized error code while preserving the primary JWT/API result; a failed login and failed cleanup are both reported. A successful login with failed cleanup still stops the transition. On resumption, the command first reconciles pending verification homes within the recorded rotation directory, including an already-absent home, before continuing active replacement. It never deletes an arbitrary path from a damaged journal.

After fresh authentication, actual source/integrated CI and owned remote cleanup are confirmed, the operator may retire the exact obsolete source key and rollback copies identified for this rotation. Verify ownership, paths and the active fingerprint first. Preserve the current candidate key, active `inputsFile`, `identity.json` and any material still needed by an unfinished proof or consumer. Do not recursively delete the identity root. Archive sanitized receipts separately. A subsequent approved preparation preserves the completed rotation in `rotationHistory` and uses the current active pair for its next rollback copy.

If removal is denied, report the exact retained material and stop that removal. Do not retry through another mechanism. Previously denied #1074–#1076 cleanup remains a separate obligation; this rotation does not authorize retrying it or reactivating those temporary ECAs. The unused legacy `SF_DEVHUB_AUTH_URL` Secret remains owner-controlled and is not needed for rotation or recovery.

## Controlled rotation on 8 September 2026

The owned permanent ECA was updated through the narrow Metadata API deployment at 16:00 UTC. Fresh candidate JWT/API verification passed at **16:01:33 UTC**, and the repository private-key Secret was updated at **16:01:35 UTC**. The client ID, username/login URL inputs, ECA policies, preauthorization and runtime grants were preserved. The new certificate fingerprint is `C2:9B:5D:4A:AE:95:6D:41:E0:46:12:5C:CE:87:B0:6B:75:71:6D:BB:81:2E:FF:DC:09:04:4A:57:BA:0B:77:BB`, valid until **8 September 2027 at 11:40:05 UTC**.

The initial attempt proved the previous JWT but stopped on local verification-home cleanup before any ECA/Secret write. Its original filesystem code was not retained. Later inspection found the expected owner/full-control ACLs, and the same removal operation succeeded. The corrected command preserved the verification outcome, reconciled that home and resumed the same journal through forward replacement. All three JWT verification homes were confirmed removed. Before/after snapshots retained the same eight active scratches, four pools and 72 slots, with identical hashes for the selected configuration and lease fields. This proves continuity during the controlled replacement; it does not attest global removal of older retained artifacts.

Actual source and integrated-main workflow acceptance, retries and final retirement are recorded in [#1079](https://github.com/Electivus/Apex-Log-Viewer/issues/1079). Local rotation success alone does not establish that acceptance.

## Lost-material recovery on 12 September 2026

After the operator confirmed loss of the registered temporary key/journal, a new 365-day pair was retained in the private durable operator root and a live ownership audit produced an immutable recovery plan. The operator approved that exact plan before active replacement. Recovery `e6202766-2077-4f9d-851a-2fc7e9ef73e7` completed at **18:41:47 UTC**, preserving the dedicated user, ECA/client ID and grants. Fresh JWT and the dedicated User API query passed before only `SF_DEVHUB_PRIVATE_KEY` was updated. Its new fingerprint is `41:DF:46:D0:00:E1:FA:CB:AC:0A:A4:1C:7E:11:7F:09:E7:C4:38:12:53:E4:AC:9C:C4:82:8E:9D:88:29:D8:49`, valid until **12 September 2027 at 15:54:55 UTC**.

Two subsequent local verifications from independent Windows CLI homes passed with the durable inputs; the source key and journal were byte-for-byte preserved and the verification homes were removed. The other three JWT Secret timestamps were unchanged. Local verification uses the fresh JWT org ID and globally unique User API identity, matching the minimum Integration profile's documented inability to query Dev Hub `Organization`. Historical phases remain unknown and rollback to the lost key is unavailable.

The actual Windows file-key pool smoke passed in **15.8 minutes**, including independent consumer import, JWT renewal/heartbeat, finalization/release, failure recovery and owned scratch/pool cleanup. Its unrelated active scratch count stayed at eight and no owned resources were retained. The JavaScript and TypeScript direct lifecycle smokes then passed in **8.5 minutes**, proving fresh JWT, renewal, PlatformCLI signup, scratch API/export/import, preservation of preexisting same-username state and owned cleanup. Both used CLI **2.150.6** with Windows Node **24.19.0**, and neither used configured retries. Their first file-input attempt stopped before scratch creation because the smoke required inline PEM; the corrected smoke accepts either supported key input without changing the runtime authentication path. Actual Linux/proxy, UI/telemetry and source/integrated-main CI acceptance remain separate, pending evidence; the initial generation copy remains retained as recorded in the operator's private approval summary.
