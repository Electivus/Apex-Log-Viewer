# Dev Hub certificate rotation and recovery

Use `scripts/devhub-identity.js` to replace the certificate on the existing owned permanent External Client App (ECA) and update its repository GitHub Actions private-key Secret. The commands retain the ECA/client ID, dedicated user, runtime permissions and Scratch Org Pool configuration. Administrator bootstrap access performs metadata work; fresh JWT verification uses the dedicated runtime identity.

## Ownership, policy and prerequisites

Electivus repository maintainers own the four GitHub Actions inputs and workflow validation. The authorized Dev Hub administrator owns ECA configuration. The Dev Hub Automation Identity remains `apex-log-viewer-ci@electivus.com`, using Salesforce Integration, its minimum API-only profile and existing audited grants. See [identity bootstrap](DEVHUB_IDENTITY.md) for the ownership marker and permission contract.

The approved policy for this installation is a **365-day certificate** and `github-actions-secret:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY`. Every preparation requires explicit lifetime, storage policy and approval reference; there is no default lifetime. Another policy needs an operator decision. No reminder or recurring rotation is installed.

Before replacing an active credential:

1. Use Node 24, the pinned pnpm, Salesforce CLI **2.150.6**, OpenSSL and authenticated `gh`. Keep the repository-pinned CLI runtime and macOS isolation described in [CI.md](CI.md). On Windows 11 use PowerShell without elevation. Retain approved proxy/CA settings and TLS verification.
2. Authenticate the authorized bootstrap administrator and independently verify the exact **18-character** Dev Hub ID. Keep the same private state directory and `identity.json` ownership UUID used to provision the active identity. Do not adopt another similarly named app or start a new state ledger.
3. Confirm the previous private key and certificate are readable, matching and unexpired. Preparation checks them and copies both into private recovery storage. **GitHub Actions Secrets cannot return an old key.** A successful Secret inventory query confirms names/timestamps only.
4. Resolve every owned proof's pending scratch/pool cleanup. Preserve shared pool leases, configuration and scratch authorization. Existing active scratches do not need deletion for a certificate rotation.
5. Schedule a quiet transition: inspect active real-org workflow runs and allow existing consumers to finish. A running/queued job may already hold the old Secret value; changing the store does not update that process. Do not reset its pool or revoke personal sessions to force the transition.

The supported metadata path has one effective `certificate` field on `ExtlClntAppGlobalOauthSettings`. Preparation performs a real dry-run of the narrow certificate update. It does not assume overlapping certificates or an atomic transaction spanning Salesforce and GitHub.

## Prepare the next certificate

Use an existing private state directory outside Git and a new, uniquely named candidate directory. Substitute verified values locally. Never put private material in command arguments, committed files, logs or CI artifacts.

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

## Private artifacts and retirement

The ledger contains ownership, phases, fingerprints, expiry and private file references. The private tree contains keys, candidate/rollback pairs, JWT inputs, retrieved metadata that can include a consumer secret, and any interrupted CLI homes. Do not publish or upload that tree. Normal JWT checks remove only their own empty-home verification state; a cleanup failure reports the exact retained directory.

Cleanup uses three bounded native filesystem retries for transient file locks. Persistent failure records a sanitized error code while preserving the primary JWT/API result; a failed login and failed cleanup are both reported. A successful login with failed cleanup still stops the transition. On resumption, the command first reconciles pending verification homes within the recorded rotation directory, including an already-absent home, before continuing active replacement. It never deletes an arbitrary path from a damaged journal.

After fresh authentication, actual source/integrated CI and owned remote cleanup are confirmed, the operator may retire the exact obsolete source key and rollback copies identified for this rotation. Verify ownership, paths and the active fingerprint first. Preserve the current candidate key, active `inputsFile`, `identity.json` and any material still needed by an unfinished proof or consumer. Do not recursively delete the identity root. Archive sanitized receipts separately. A subsequent approved preparation preserves the completed rotation in `rotationHistory` and uses the current active pair for its next rollback copy.

If removal is denied, report the exact retained material and stop that removal. Do not retry through another mechanism. Previously denied #1074–#1076 cleanup remains a separate obligation; this rotation does not authorize retrying it or reactivating those temporary ECAs. The unused legacy `SF_DEVHUB_AUTH_URL` Secret remains owner-controlled and is not needed for rotation or recovery.

## Controlled rotation on 8 September 2026

The owned permanent ECA was updated through the narrow Metadata API deployment at 16:00 UTC. Fresh candidate JWT/API verification passed at **16:01:33 UTC**, and the repository private-key Secret was updated at **16:01:35 UTC**. The client ID, username/login URL inputs, ECA policies, preauthorization and runtime grants were preserved. The new certificate fingerprint is `C2:9B:5D:4A:AE:95:6D:41:E0:46:12:5C:CE:87:B0:6B:75:71:6D:BB:81:2E:FF:DC:09:04:4A:57:BA:0B:77:BB`, valid until **8 September 2027 at 11:40:05 UTC**.

The initial attempt proved the previous JWT but stopped on local verification-home cleanup before any ECA/Secret write. Its original filesystem code was not retained. Later inspection found the expected owner/full-control ACLs, and the same removal operation succeeded. The corrected command preserved the verification outcome, reconciled that home and resumed the same journal through forward replacement. All three JWT verification homes were confirmed removed. Before/after snapshots retained the same eight active scratches, four pools and 72 slots, with identical hashes for the selected configuration and lease fields. This proves continuity during the controlled replacement; it does not attest global removal of older retained artifacts.

Actual source and integrated-main workflow acceptance, retries and final retirement are recorded in [#1079](https://github.com/Electivus/Apex-Log-Viewer/issues/1079). Local rotation success alone does not establish that acceptance.
