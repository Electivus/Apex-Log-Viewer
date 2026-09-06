# Permanent JWT authentication for Dev Hub automation

## Problem Statement

Real-org validation depends on a Dev Hub authorization URL backed by an interactive refresh token. When that credential expires or is revoked, automated validation fails before it can acquire or create a Salesforce test environment. Authentication policy is repeated across runners and the proxy lab, while pool administration assumes that authentication already exists. Renewing a personal login does not provide a durable operational solution.

Simply replacing every authorization with JWT is insufficient. A live test confirmed that Salesforce accepts an External Client App for Dev Hub JWT login, but default scratch signup cannot replicate that application and fails with `C-1016`. The Scratch Org Pool also depends on exportable scratch authorization URLs that another runner can import. The migration must address the Dev Hub credential without breaking that contract.

The current pool permission set has been used by an administrator and does not grant creation of `ScratchOrgInfo`. A dedicated minimum-access user therefore needs explicit permissions and behavior-level validation.

## Solution

Use a dedicated Dev Hub Automation Identity authenticated with certificate-backed JWT through a permanent External Client App. Require JWT configuration for real-org CI, with clear errors for absent, partial, or invalid configuration. Preserve explicit use of an already authenticated Dev Hub alias for local developers.

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
13. As a local developer, I want to keep using an explicitly configured authenticated alias, so that ordinary local work does not require CI secrets.
14. As a local developer, I want a configured JWT failure to remain visible, so that local alias support does not hide an invalid certificate or username.
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
- **DEC-005:** Require JWT in CI, reject legacy authorization-URL fallback there, and retain explicit authenticated-alias support locally.
- **DEC-007:** Use the authorized purpose-specific `electivus.com` alias for the automation contact and initial username; handle global Salesforce username collisions without changing the agreed domain.
- **DEC-009:** Test Salesforce Integration with the minimum API-only profile and permission set license first; if required Dev Hub behavior is unsupported, use Salesforce with a minimum-access profile rather than System Administrator.

The authentication policy must be shared by the JavaScript test runner, TypeScript E2E runner, pool-administration commands, and proxy-lab preflight. Adapters retain their existing Salesforce CLI execution mechanisms. Prefer the existing command and workflow interfaces to introducing another orchestration layer.

JWT inputs comprise the client ID, username, private-key material or a key-file reference, and login URL. Configuration resolution must distinguish absent, incomplete, and complete JWT settings. In CI, the JWT requirement takes precedence over aliases or legacy values. Once JWT is selected, authentication errors must not trigger another credential mechanism. Error messages identify configuration names and actionable failures without including credential contents.

The tested scratch-signup configuration uses `SF_SCRATCH_SIGNUP_CONNECTED_APP=PlatformCLI` and `SF_SCRATCH_SIGNUP_CALLBACK_URL=http://localhost:1717/OauthRedirect`. Scope these settings to scratch-creation child processes; they must not replace the ECA used to authenticate the Dev Hub itself.

The permanent ECA uses a certificate and the tested `Api,RefreshToken` scopes, explicit permission-set preauthorization, and enforced IP restrictions. The dedicated user needs the scratch lifecycle grants, required pool and slot data access, and access to the pool's Apex REST classes. Correct the missing `ScratchOrgInfo.Create` permission and test actual operations before expanding any privileges. App metadata deployment remains an administrator bootstrap responsibility.

Salesforce CLI 2.150.6 passed the Windows feasibility test. The selected CI version must support the signup override and valid credential export, while preserving the existing macOS Node 20 isolation for Salesforce CLI. Redacted values must not pass validation merely because they are nonempty. Any CLI opt-in required to export usable credentials must be scoped to the consuming child process, with secret-safe logging and artifact handling.

Update all real-org workflow gates and credential propagation together with the runner behavior. Preserve corporate proxy and CA handling, keep TLS verification enabled, and avoid embedding private keys in images or versioned files. Preserve current pool records and handle any ownership transition explicitly; do not reset live pools to make validation pass.

## Testing Decisions

### Primary behavioral boundary

The primary seam is the existing real-org validation and pool-operation entry points: authenticate the intended Dev Hub, obtain a pool environment, create a scratch when required, use it, and release or delete it. Verify this through the existing command surfaces and one consolidated real-org smoke scenario. Tests should assert observable results and stable interface contracts rather than private helper structure, source-text patterns, or a prescribed sequence of internal calls.

Reuse the existing `ensureScratchOrg` tests, test-runner `ensureDevHub` tests, pool-administration tests, Salesforce CLI execution tests, workflow-contract tests, and proxy-lab tests. Focus fast tests on configuration, failures, and adapter boundaries; avoid repeating the full authentication matrix in every adapter.

### Required fast coverage

- Complete JWT settings select JWT in CI and local runs; absent or partial settings fail clearly in CI before pool changes.
- CI does not fall back to the legacy Dev Hub auth URL or a cached alias. An explicit local alias still works when JWT is not configured.
- An invalid selected JWT configuration produces an actionable error without exposing the key, token, authorization URL, or consumer secret and without silently switching identities.
- Existing CLI executable resolution and the macOS Salesforce CLI runtime isolation remain intact.
- Scratch creation receives the `PlatformCLI` override; the Dev Hub retains its ECA identity.
- Usable scratch credentials survive export/import, while redaction placeholders and malformed values are rejected.
- Relevant workflows and proxy-lab commands receive the required configuration; private-key material is not embedded in images, command output, or artifacts.
- Temporary-key cleanup occurs on successful and failing operations, with explicit reporting if cleanup is blocked.

### Required live coverage

1. Authenticate the dedicated user through the permanent ECA from an isolated CLI state and query the intended Dev Hub.
2. Prove the selected license and permission grants support the required pool operations and scratch lifecycle. Exercise the authorized minimum-access Salesforce fallback if Integration is incompatible.
3. Create a scratch through `PlatformCLI`, query its API, export its authorization, import into a second empty CLI state, and query from that state.
4. Exercise pool acquisition, finalization, heartbeat, release, and maintenance using an isolated test pool. Confirm cleanup and reporting on failure.
5. Verify the transition for pre-existing scratch ownership when it affects the migration, without silently adding broad administrator rights or resetting live pools.
6. Delete test scratch resources and report any retained metadata or credential material explicitly.
7. Run the actual real-org CI workflow after configuration, including the relevant proxy-lab and platform paths. Report any unvalidated path as a limit rather than inferring success from source inspection.

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

The feasibility test passed ECA/JWT Dev Hub login, scratch signup using `PlatformCLI`, scratch API queries, and authorization import into an independent CLI state. Default ECA scratch signup failed with `C-1016`, confirming that the authentication separation is required for the tested flow. The test scratch was deleted, and the temporary ECA was disabled with rejection of new JWT logins verified.

The permanent credential-lifecycle policy is **not yet confirmed**. The proposal discussed was a private key in a repository GitHub Actions Secret, a certificate valid for 12 months, and documented rotation. Keep this as an operator decision; do not hardcode an unconfirmed lifetime or present the proposed storage policy as approved. Production credential provisioning and cutover require this decision, while implementation of the configurable authentication behavior can proceed independently.

Local discovery found available Integration and Salesforce licenses; availability must be rechecked during provisioning. Integration eligibility for the Dev Hub scratch objects has not been proven. The existing pool permission set was assigned only to an administrator, so its successful historical use does not establish least-privilege compatibility.

Execution approval review blocked deletion of the temporary local experiment credential files, including an attempt restricted to exact filenames. They remain local; no temporary key or authorization URL belongs in the repository or this issue. The associated test ECA is disabled and the scratch org is deleted.

The published specification is the implementation contract. The Planning context below identifies its active decisions and durable checkpoint; verification obligations remain pending except for the completed feasibility experiment.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: de9a31a62a59b3960bafb580bdfbeb825505b815
- Decisions: DEC-001, DEC-002, DEC-003, DEC-004, DEC-005, DEC-007, DEC-008, DEC-009
