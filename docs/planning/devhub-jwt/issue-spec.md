# Permanent JWT authentication for Dev Hub automation

## Problem Statement

Real-org validation depends on a Dev Hub authorization URL backed by an interactive refresh token. When that credential expires or is revoked, automated validation fails before it can acquire or create a Salesforce test environment. Authentication policy is repeated across runners and the proxy lab, while pool administration assumes that authentication already exists. Renewing a personal login does not provide a durable operational solution.

Simply replacing every authorization with JWT is insufficient. A live test confirmed that Salesforce accepts an External Client App for Dev Hub JWT login, but default scratch signup cannot replicate that application and fails with `C-1016`. The Scratch Org Pool also depends on exportable scratch authorization URLs that another runner can import. The migration must address the Dev Hub credential without breaking that contract.

The current pool permission set has been used by an administrator and does not grant creation of `ScratchOrgInfo`. A dedicated minimum-access user therefore needs explicit permissions and behavior-level validation.

## Solution

Use a dedicated Dev Hub Automation Identity authenticated with certificate-backed JWT through a permanent External Client App. Require JWT configuration for real-org CI and local validation, with clear errors for absent, partial, or invalid configuration before Dev Hub or pool mutations. An authenticated alias, cached account or legacy authorization URL must not substitute for JWT.

Use Salesforce's existing built-in `PlatformCLI` application for scratch signup. Retain the Scratch Org Pool's exportable SFDX authorization URLs, lease behavior, and independent-runner import flow. Apply one shared authentication policy across the test runners, pool administration, and proxy-lab entry points.

Provision the user with the minimum Integration profile and appropriate permission sets first. If the Integration license cannot perform the required Dev Hub operations, use an available Salesforce license with its minimum-access profile. Keep administrator bootstrap responsibilities separate from runtime permissions. Document installation, configuration, credential rotation, recovery, and cutover, and verify the completed behavior in actual real-org CI.

## User Stories

1. As a maintainer, I want real-org validation to authenticate without a personal refresh token, so that an expired interactive login does not block validation.
2. As a maintainer, I want one dedicated Dev Hub Automation Identity, so that automation access has a distinct owner and lifecycle.
3. As an administrator, I want the automation user to have only the permissions required for its work, so that CI does not need System Administrator.
4. As an administrator, I want to use an available Integration license when it supports the workflow, so that the automation uses the narrower account type.
5. As an administrator, I want a tested minimum-access Salesforce fallback when Integration is incompatible, so that license restrictions do not make the migration unusable.
6. As an administrator, I want the automation contact to use the authorized purpose-specific domain alias, so that contact messages reach the configured mailbox.
7. As an operator, I want the new user and ECA to be provisioned reproducibly, so that recovery does not depend on remembering manual setup steps.
8. As an operator, I want app creation and metadata deployment to remain bootstrap operations, so that runtime automation does not need general configuration privileges.
9. As a CI runner, I want complete JWT configuration to select the intended Dev Hub deterministically, so that tests cannot silently use an unrelated local account.
10. As a CI runner, I want missing JWT configuration to fail before pool mutations, so that the failure identifies the actual setup problem.
11. As a CI runner, I want partial JWT configuration to fail explicitly, so that a malformed setup cannot silently switch authentication methods.
12. As a maintainer, I want the old Dev Hub authorization URL to stop being a CI fallback, so that the expiring credential is no longer a hidden dependency.
13. As a local developer, I want repeatable JWT authentication with durable private operator inputs, so that local validation exercises the dedicated identity without relying on temporary state or a personal alias.
14. As a local developer, I want absent or invalid JWT settings to fail explicitly, so that a cached login cannot hide a configuration or certificate problem.
15. As an operator, I want the private key and authorization values excluded from logs and artifacts, so that debugging does not disclose credentials.
16. As an operator, I want temporary credential files to be scoped to the operation and cleaned up, so that authentication does not leave unnecessary plaintext material behind.
17. As a pool maintainer, I want scratch signup to use the tested `PlatformCLI` path, so that ECA replication failures do not prevent environment creation.
18. As a pool maintainer, I want scratch credentials to remain exportable and importable, so that a separate runner can use an acquired environment.
19. As a pool maintainer, I want the same pool records and lease contract to remain valid, so that this migration does not require rebuilding the pool data model.
20. As a pool maintainer, I want creation, reconciliation, and deletion tested under the dedicated user, so that administrator privileges do not mask missing grants.
21. As a pool maintainer, I want existing scratch ownership handled explicitly, so that moving to a dedicated identity does not break cleanup of older environments.
22. As a proxy-lab user, I want JWT credentials supplied safely to the isolated runner, so that corporate-network validation exercises the same authentication policy as CI.
23. As a developer on the corporate notebook, I want certificate verification and corporate trust preserved, so that the solution works without weakening TLS or requiring elevation.
24. As a maintainer, I want a pinned Salesforce CLI version proven to support the signup and credential-export behavior, so that upgrades do not silently change the authentication contract.
25. As a maintainer, I want Windows, Linux, and macOS execution rules preserved, so that the migration does not regress executable resolution or the existing macOS CLI runtime isolation.
26. As an operator, I want a documented certificate rotation and recovery procedure, so that certificate expiry does not recreate an undocumented authentication outage.
27. As a maintainer, I want a real-org smoke test with credential reimport from an empty CLI state, so that a successful local cached session is not mistaken for end-to-end proof.
28. As a maintainer, I want actual workflow execution after configuration, so that local tests are not the only evidence that the migration works.
29. As a maintainer, I want validation resources cleaned up or explicitly reported, so that experiments do not consume active scratch capacity indefinitely.
30. As a maintainer, I want this delivery focused on JWT authentication, so that unrelated Dependabot triage does not expand the work.

## Implementation Decisions

- **DEC-001:** Replace interactive refresh-token based Dev Hub authentication with JWT in automated real-org validation.
- **DEC-002:** Retain the completed live ECA feasibility test as prerequisite evidence and add implementation-level validation; do not treat feasibility as proof of the new user or CI.
- **DEC-003:** Keep ECA/JWT for the Dev Hub and apply the `PlatformCLI` signup override to scratch creation; preserve exportable scratch authorization URLs and pin a compatible Salesforce CLI.
- **DEC-004:** Provision a dedicated Dev Hub Automation Identity and validate runtime permissions independently of the administrator bootstrap identity.
- **DEC-011:** Require JWT for Dev Hub authentication locally and in CI, superseding DEC-005 and removing the local-alias exception. Preserve PlatformCLI scratch authentication and separate administrator bootstrap.
- **DEC-012:** Keep private operator credentials and identity/recovery state in durable per-user storage; handle missing historical material through an explicit same-identity recovery plan without claiming that GitHub can return the Secret value.
- **DEC-007:** Use the authorized purpose-specific `electivus.com` alias for the automation contact and initial username; handle global Salesforce username collisions without changing the agreed domain.
- **DEC-009:** Test Salesforce Integration with the minimum API-only profile and permission set license first; if required Dev Hub behavior is unsupported, use Salesforce with a minimum-access profile rather than System Administrator.
- **DEC-010:** Run the isolated macOS Salesforce CLI 2.150.6 with Node from `.nvmrc` (24.15.0 at cutover). Prove the captured wrapper, empty-state CLI, dedicated JWT identity, scratch signup/API, and cross-home import in actual CI.

The authentication policy must be shared by the JavaScript test runner, TypeScript E2E runner, pool-administration commands, and proxy-lab preflight. Adapters retain their existing Salesforce CLI execution mechanisms. Prefer the existing command and workflow interfaces to introducing another orchestration layer.

JWT inputs comprise the client ID, username, private-key material or a key-file reference, and login URL. Configuration resolution must distinguish absent, incomplete, and complete JWT settings. Both local and CI entry points require the complete tuple and fail before Dev Hub or pool mutations if it is absent or invalid, even when aliases, cached accounts or legacy values exist. Authentication errors must not trigger another credential mechanism. Error messages identify configuration names and actionable failures without including credential contents.

Keep the local operator key, certificate, journal and input references in private durable storage outside Git, temporary roots and synchronized folders. Restrict per-user access and pass only scoped private inputs to WSL or containers. Normal test cleanup removes its own transient copies while preserving durable recovery state. Missing keys or journals require auditable ownership reconciliation and an explicit recovery plan; never manufacture successful history or assume rollback when the previous pair is unavailable. Active replacement preserves the ECA/client ID, dedicated user, grants, 365-day policy and repository Actions Secret contract, with fresh local JWT and actual integrated CI verified separately.

The tested scratch-signup configuration uses `SF_SCRATCH_SIGNUP_CONNECTED_APP=PlatformCLI` and `SF_SCRATCH_SIGNUP_CALLBACK_URL=http://localhost:1717/OauthRedirect`. Scope these settings to scratch-creation child processes; they must not replace the ECA used to authenticate the Dev Hub itself.

The permanent ECA uses a certificate and the tested `Api,RefreshToken` scopes, explicit permission-set preauthorization, and enforced IP restrictions. The dedicated user needs the scratch lifecycle grants, required pool and slot data access, and access to the pool's Apex REST classes. Correct the missing `ScratchOrgInfo.Create` permission and test actual operations before expanding any privileges. App metadata deployment remains an administrator bootstrap responsibility.

Salesforce CLI 2.150.6 passed the Windows feasibility test. The selected CI version must support the signup override and valid credential export. Preserve the isolated, sanitized macOS wrapper while capturing the supported Node runtime from `.nvmrc` (24.15.0 at cutover); DEC-010 replaces the former Node 20 constraint because the pinned CLI requires Node >=22. Redacted values must not pass validation merely because they are nonempty. Any CLI opt-in required to export usable credentials must be scoped to the consuming child process, with secret-safe logging and artifact handling.

Update all real-org workflow gates and credential propagation together with the runner behavior. Preserve corporate proxy and CA handling, keep TLS verification enabled, and avoid embedding private keys in images or versioned files. Preserve current pool records and handle any ownership transition explicitly; do not reset live pools to make validation pass.

## Testing Decisions

### Primary behavioral boundary

The primary seam is the existing real-org validation and pool-operation entry points: authenticate the intended Dev Hub, obtain a pool environment, create a scratch when required, use it, and release or delete it. Verify this through the existing command surfaces and one consolidated real-org smoke scenario. Tests should assert observable results and stable interface contracts rather than private helper structure, source-text patterns, or a prescribed sequence of internal calls.

Reuse the existing `ensureScratchOrg` tests, test-runner `ensureDevHub` tests, pool-administration tests, Salesforce CLI execution tests, workflow-contract tests, and proxy-lab tests. Focus fast tests on configuration, failures, and adapter boundaries; avoid repeating the full authentication matrix in every adapter.

### Required fast coverage

- Complete JWT settings select JWT in CI and local runs; absent or partial settings fail clearly in both contexts before Dev Hub or pool changes.
- Neither CI nor local validation falls back to the legacy Dev Hub auth URL, an explicit authenticated alias or a cached account when JWT is absent or fails.
- An invalid selected JWT configuration produces an actionable error without exposing the key, token, authorization URL, or consumer secret and without silently switching identities.
- Existing CLI executable resolution and the macOS Salesforce CLI runtime isolation remain intact.
- Scratch creation receives the `PlatformCLI` override; the Dev Hub retains its ECA identity.
- Usable scratch credentials survive export/import, while redaction placeholders and malformed values are rejected.
- Relevant workflows and proxy-lab commands receive the required configuration; private-key material is not embedded in images, command output, or artifacts.
- Temporary-key cleanup occurs on successful and failing operations, with explicit reporting if cleanup is blocked.
- Durable operator inputs survive normal test cleanup; missing ownership/journal/key evidence and unavailable rollback fail or remain explicitly unresolved without active credential writes.

### Required live coverage

1. Authenticate the dedicated user through the permanent ECA from an isolated CLI state and query the intended Dev Hub.
2. Prove the selected license and permission grants support the required pool operations and scratch lifecycle. Exercise the authorized minimum-access Salesforce fallback if Integration is incompatible.
3. Create a scratch through `PlatformCLI`, query its API, export its authorization, import into a second empty CLI state, and query from that state.
4. Exercise pool acquisition, finalization, heartbeat, release, and maintenance using an isolated test pool. Confirm cleanup and reporting on failure.
5. Verify the transition for pre-existing scratch ownership when it affects the migration, without silently adding broad administrator rights or resetting live pools.
6. Delete test scratch resources and report any retained metadata or credential material explicitly.
7. Run the actual real-org CI workflow after configuration, including the relevant proxy-lab and platform paths. Report any unvalidated path as a limit rather than inferring success from source inspection.
8. Repeat local JWT validation from isolated CLI state with the durable operator inputs and the selected supported Windows, WSL or Docker path; no personal Dev Hub alias substitutes for this proof.

The proposed test strategy reuses these existing entry points. It introduces no additional public test-only interface unless implementation demonstrates that the behavior cannot be observed through an existing boundary.

## Out of Scope

- Dependabot PR triage or unrelated dependency changes. **DEC-008 has no specification obligation:** it is a scope-only instruction and creates no additional product feature or ticket.
- Product runtime authentication, Apex log storage, release behavior, and unrelated application changes.
- A new Scratch Org Pool data model or a migration to JWT-only scratch credentials.
- Creation of a new classic Connected App in the Dev Hub.
- Runtime System Administrator access, disabling TLS verification, or administrator elevation on the corporate notebook.
- New snapshot functionality or broad permission cleanup. Existing snapshot-related license constraints must remain visible if that mode is selected.
- A scheduled rotation/reminder automation without a separate user request.

## Further Notes

Evidence: [live ECA/JWT feasibility report](https://github.com/Electivus/Apex-Log-Viewer/blob/fa97db1fcfa45990689797450df954fc3679fae8/docs/planning/devhub-jwt/eca-jwt-experiment.md) and [ADR-0004](https://github.com/Electivus/Apex-Log-Viewer/blob/fa97db1fcfa45990689797450df954fc3679fae8/docs/adr/0004-separate-devhub-and-scratch-authentication.md).

The feasibility test passed ECA/JWT Dev Hub login, scratch signup using `PlatformCLI`, scratch API queries, and authorization import into an independent CLI state. Default ECA scratch signup failed with `C-1016`, confirming that the authentication separation is required for the tested flow. The test scratch was deleted, and the temporary ECA was disabled with rejection of new JWT logins verified.

The operator-approved credential policy is a private key in repository GitHub Actions Secrets and an explicitly supplied **365-day certificate**. Provisioning in #1077, production cutover in #1078 and controlled rotation in #1079 used this policy. The policy remains an explicit operator input. Active local key/journal and recovery material must remain private and durable; the registered temporary paths were absent on 12 September 2026, so their availability or successful retirement cannot be assumed. GitHub cannot return a previous Secret value.

The dedicated Salesforce Integration identity with Minimum Access - API Only Integrations and SalesforceAPIIntegrationPsl passed native definition-mode scratch and pool validation in #1077 and integrated production in #1078. The minimum-access Salesforce fallback was not needed live. Snapshot entitlement remains unproven and older-owner cleanup retains its explicit transition procedure. Future provisioning must still recheck capacity, effective grants and actual behavior.

Execution approval review previously blocked deletion of the temporary local experiment credential files, including an attempt restricted to exact filenames. They were reported retained at that time; their current presence requires checking the exact recorded references. No retry through another mechanism is authorized. No temporary key or authorization URL belongs in the repository or this issue. The associated test ECA was disabled and the scratch org was deleted.

The published specification remains the implementation contract. The Planning context identifies the active decisions and durable checkpoint. The coordinator has aggregated implementation verification across all six delivery slices, preserving the original feasibility evidence and historical verification records. This does not close #1079 or #1073: final PR gates, actual integrated-main rotation verification and retirement/retention reporting remain acceptance requirements.

### Runtime correction during #1078

**DEC-010:** Keep CLI 2.150.6 and capture supported Node from `.nvmrc`. Preserve sanitization and runtime restoration. Prove empty-state org list, dedicated JWT identity, signup/API/export/import in actual macOS CI. Approved after run 34174333682 exposed the unsupported Node 20 runtime; actual integrated macOS production verification passed in #1078, with additional current-credential receipts in #1079.

## Historical execution status - 9 September 2026

#1074-#1078 are accepted and integrated. #1079 has reviewed code, controlled live rotation/recovery and complementary CI evidence at source `1dbd80ed5ff4d126838d4bc588ee7353741f0045`. [The coordinator verification report](https://github.com/Electivus/Apex-Log-Viewer/blob/a4c28849d40ba1e1f949bd5e689e71f9cc047dc3/docs/planning/devhub-jwt/implementation-verification.md) maps the complete graph, exact sources, runtime receipts, review counts and retained resources.

The native PR production gates passed on the same Git tree as the six explicit JWT lifecycle receipts and isolated pool receipt. The explicit candidate run remains **failed** with Azure `AADSTS700213` for the unsupported feature-branch federation; its failure is not waived or relabeled. The coordinator approved using these complementary receipts before merge, preserving all final-head required checks. A complete opted-in workflow on the actual integrated `main` SHA must pass and its receipts must be inspected before final acceptance or retirement. #1079 and this parent remain open until that evidence and cleanup qualifications are reconciled.

## Policy extension - 12 September 2026

The user revoked the authenticated Dev Hub alias exception for local development. DEC-011 supersedes DEC-005; DEC-012 adds durable local operator state and explicit recovery after its loss. T06/#1079 owns the remaining implementation, public-boundary tests, operator documentation, local JWT proof and final integrated validation. Earlier accepted tickets and verification records remain historical evidence; they do not prove these new obligations.

PR #1097 was merged as `29f44560bd5a63043307edd297dd9a8689f31630`. Run `34384880623`, attempt 3, passed the six JS/TS JWT lifecycle receipts and the isolated pool/cleanup proof, but failed Linux UI and skipped telemetry. Its complete integration acceptance remains pending. The new storage/recovery requirements do not authorize an unplanned active certificate or Secret change, and neither issue is closed by this Planning update.

## Actions and Dependabot rotation extension - 12 September 2026

The user approved DEC-013 after PR #1098 merged: future rotation and recovery must update `SF_DEVHUB_PRIVATE_KEY` in both repository Actions and Dependabot Secrets under the explicit `github-actions-dependabot-secrets:Electivus/Apex-Log-Viewer/SF_DEVHUB_PRIVATE_KEY` policy. All four JWT inputs must be present in each scope before active writes; the other three values remain unchanged.

T06/#1079 owns a follow-up PR. Preserve Actions-only journals and support an explicit upgrade in the same repository; reject a downgrade or repository change. Bind the selected scopes and all input timestamps during preparation. Record pending and confirmed deliveries separately, reconcile uncertain writes, and complete only after both scopes match the selected direction. Rollback must restore the previous key in both scopes even when the previous material's policy mentions Actions only. Reject drift in non-key inputs or confirmed key timestamps, including completed replay. Lost-material recovery binds both inventories in its approved plan while preserving unknown history and unavailable rollback. Test these behaviors through the existing public command interface and document the next operation. This code follow-up does not replace the active certificate or authorize dependency PR triage or merge.

Prior-scope integrated acceptance is now established at main `1bd1ac3156fd83a4ea69299c65d9675e44939001`: CI `34721708541` and opted-in workflow `34721729839` passed on attempt 1. All six inspected JS/TS JWT lifecycle receipts and the isolated pool/consumer cleanup receipt passed. Windows IntelliJ and errors-only UI tests each used one configured retry; telemetry validated 19 events across five names in one query. Historical failures and retained private material remain recorded. This evidence does not attest the newly requested dual-store code, and #1073 stays open.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 915e9ffa71d925fe63f6d2e1037f172d0ba85e50
