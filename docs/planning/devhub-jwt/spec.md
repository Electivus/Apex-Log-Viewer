# Permanent Dev Hub JWT authentication

Status: historical interview draft. The [published implementation specification](https://github.com/Electivus/Apex-Log-Viewer/issues/1073), maintained locally as [issue-spec.md](issue-spec.md), supersedes this draft. Refer to its explicit credential-lifecycle prerequisite before permanent provisioning.

## Intended outcome

Automated real-org validation and scratch-pool maintenance authenticate to the Dev Hub using a dedicated automation identity and an External Client App with JWT, both in CI and during local development. Missing, partial or invalid JWT configuration fails clearly before Dev Hub or pool mutations, even when an authenticated alias or cached account exists. DEC-011 supersedes the former local-alias exception.

Scratch signup uses Salesforce's existing `PlatformCLI` application. Scratch credentials remain exportable SFDX authorization URLs, preserving the current pool storage and runner-import contract. The [feasibility report](eca-jwt-experiment.md) records the live proof and its boundaries; [ADR-0004](../../adr/0004-separate-devhub-and-scratch-authentication.md) records the authentication separation.

## Confirmed decisions

| Decision | Actionable consequence |
| --- | --- |
| DEC-001 | Replace refresh-token based Dev Hub authentication with certificate-backed JWT in automated validation. |
| DEC-002 | Use the completed ECA feasibility test as evidence; still run implementation-level tests. |
| DEC-003 | Apply the `PlatformCLI` scratch-signup override and pin a compatible Salesforce CLI version. Preserve scratch authorization URL storage and import. |
| DEC-004 | Provision and validate a dedicated automation identity instead of retaining the personal administrator account. |
| DEC-011 | Require JWT locally and in CI; reject alias, cached-account and legacy authorization-URL fallback for the Dev Hub. |
| DEC-012 | Preserve private operator credentials and recovery state in durable storage and explicitly handle loss of the local material. |
| DEC-007 | Use the user-authorized purpose-specific `electivus.com` contact alias; ensure global Salesforce username uniqueness at provisioning. |
| DEC-008 | Deliver this authentication migration only; do not continue Dependabot triage. |
| DEC-009 | Test the minimum Integration license/profile combination and use a minimum Salesforce profile if the required Dev Hub operations are unsupported. |
| DEC-010 | Use the repository-pinned Node runtime for the isolated macOS Salesforce CLI. |

## User and application provisioning

Provisioning and metadata deployment use the already authorized administrator as a bootstrap identity. Runtime automation does not receive System Administrator or general metadata-administration permissions.

Start by testing Salesforce Integration with the existing `Minimum Access - API Only Integrations` profile and the Salesforce API Integration permission set license. If its license boundaries block the required Dev Hub operations, use an available Salesforce license with `Minimum Access - Salesforce`. Live discovery found capacity for both; counts are not provisioning guarantees and must be rechecked when creating the user.

The runtime permission set must cover the actual pool REST classes, pool/slot fields, and scratch-org lifecycle. Add the missing `ScratchOrgInfo.Create` grant. Validate access under the new user; the current pool permission set has only been exercised by an administrator. Preserve the existing pool contract and avoid unrelated permission-set cleanup.

Give the dedicated identity explicit preauthorization in a new permanent ECA. Use the successful certificate/scopes/policy shape from the feasibility test, including `Api,RefreshToken`, enforced IP restrictions, and permission-set API names. Keep the temporary disabled test ECA out of production configuration.

## Runtime integration

Provide one shared Dev Hub authentication policy for the JavaScript test runner, TypeScript E2E utilities, proxy-lab preflight, and scratch-pool administration. Each adapter passes its existing Salesforce CLI execution mechanism so platform-specific executable resolution remains intact.

The configuration contract includes a JWT client ID, username, private-key file or secret-to-file input, and login URL. Require the complete tuple locally and in CI; an absent, partial or invalid tuple must not select an authenticated Dev Hub alias, cached personal account or legacy authorization URL. Error messages identify configuration names without including credential values. This policy does not remove PlatformCLI scratch authorization import or the separate authorized administrator bootstrap operation.

Scope `SF_SCRATCH_SIGNUP_CONNECTED_APP=PlatformCLI` and `SF_SCRATCH_SIGNUP_CALLBACK_URL=http://localhost:1717/OauthRedirect` to the scratch-creation child environment. The parent Dev Hub connection must continue using its ECA/JWT identity.

Pin the Salesforce CLI to a version validated for this flow; 2.150.6 passed the Windows feasibility test. Preserve macOS CLI isolation with the supported Node runtime from `.nvmrc` under DEC-010. Validate credential redaction handling: never accept a redaction placeholder as an auth URL, and scope any required secret-export opt-in to the child process consuming it. Keep credentials out of logs and test artifacts.

Update workflow credential gates, all real-org jobs, proxy-lab credential transport and documentation together. Container execution must keep TLS verification and the existing corporate CA/proxy path. Use ephemeral files or an appropriately scoped read-only mount for the private key; avoid embedding credentials into a container image or repository file.

## Credential lifecycle — pending final decision

The approved CI policy is a repository GitHub Actions Secret with an explicitly supplied 365-day certificate. Keep the local operator key, certificate, identity journal and input references in private durable per-user storage outside Git, temporary roots and synchronized folders. Restrict access and transport only scoped private inputs to WSL or containers; do not embed them in images or output.

The procedure must specify certificate replacement, Secret replacement, verification, interrupted-rotation recovery and loss of local recovery material. GitHub cannot return a stored Secret value. If the original journal or key is unavailable, preserve that uncertainty, verify ownership from auditable sources and prepare an explicit recovery plan for the same ECA/client ID and identity. Do not fabricate completed history, assume rollback without a retained old key or change active credentials before the concrete operator-approved plan. Local JWT proof and successful integrated CI remain separate requirements. T06/#1079 owns this extension under DEC-012.

Do not install a recurring rotation or reminder automation unless the user requests one. Do not commit a generated key, authorization URL, retrieved client secret, or user-specific authentication state.

## Validation and cutover

1. Validate absent/partial/invalid JWT configuration, strict local and CI behavior despite an alias or cached account, CLI argument construction and secret-safe errors through public command boundaries.
2. Validate workflow/container propagation and regression tests affected by the CLI version pin.
3. Create the dedicated identity and permanent ECA within the chosen license constraints; verify JWT login and a Dev Hub query.
4. Under that identity, verify scratch creation through `PlatformCLI`, a scratch API query, export/import into an isolated state directory, and scratch deletion.
5. Exercise the pool lease/finalization/release path and maintenance operations using an isolated test pool. Do not reset or rewrite existing pools merely to pass the smoke test.
6. Check any ownership boundary affecting pre-existing scratch orgs; use an explicit migration step if needed rather than granting broad administrator access.
7. Configure the repository's JWT inputs, run actual real-org CI, and confirm the old Dev Hub authorization URL is no longer a dependency.
8. Document the final app/user setup, configuration locations, operational commands, rotation, and reversal. Record actual validation limits rather than treating source inspection or a local login as CI proof.
9. Prove repeatable local JWT execution from isolated CLI state using durable operator inputs and scoped WSL/container transport; test lost-material recovery prerequisites and report unavailable rollback explicitly.

## Exclusions

This effort does not change product runtime authentication, log storage, the scratch-pool data model, unrelated dependency versions, or release behavior. Existing snapshot support remains a separate license/permission consideration; the currently configured pools use definition-based creation.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 915e9ffa71d925fe63f6d2e1037f172d0ba85e50
