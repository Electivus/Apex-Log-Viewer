# Permanent Dev Hub JWT authentication

Status: design interview in progress. Implementation starts after the user's final shared-understanding confirmation.

## Intended outcome

Automated real-org validation and scratch-pool maintenance authenticate to the Dev Hub using a dedicated automation identity and an External Client App with JWT. Missing or partial JWT configuration in CI fails clearly before attempting pool operations. Local developers may continue to use an already authenticated Dev Hub alias.

Scratch signup uses Salesforce's existing `PlatformCLI` application. Scratch credentials remain exportable SFDX authorization URLs, preserving the current pool storage and runner-import contract. The [feasibility report](eca-jwt-experiment.md) records the live proof and its boundaries; [ADR-0004](../../adr/0004-separate-devhub-and-scratch-authentication.md) records the authentication separation.

## Confirmed decisions

| Decision | Actionable consequence |
| --- | --- |
| DEC-001 | Replace refresh-token based Dev Hub authentication with certificate-backed JWT in automated validation. |
| DEC-002 | Use the completed ECA feasibility test as evidence; still run implementation-level tests. |
| DEC-003 | Apply the `PlatformCLI` scratch-signup override and pin a compatible Salesforce CLI version. Preserve scratch authorization URL storage and import. |
| DEC-004 | Provision and validate a dedicated automation identity instead of retaining the personal administrator account. |
| DEC-005 | Reject the legacy Dev Hub authorization URL in CI; preserve explicit local alias use. |
| DEC-007 | Use the user-authorized purpose-specific `electivus.com` contact alias; ensure global Salesforce username uniqueness at provisioning. |
| DEC-008 | Deliver this authentication migration only; do not continue Dependabot triage. |
| DEC-009 | Test the minimum Integration license/profile combination and use a minimum Salesforce profile if the required Dev Hub operations are unsupported. |

## User and application provisioning

Provisioning and metadata deployment use the already authorized administrator as a bootstrap identity. Runtime automation does not receive System Administrator or general metadata-administration permissions.

Start by testing Salesforce Integration with the existing `Minimum Access - API Only Integrations` profile and the Salesforce API Integration permission set license. If its license boundaries block the required Dev Hub operations, use an available Salesforce license with `Minimum Access - Salesforce`. Live discovery found capacity for both; counts are not provisioning guarantees and must be rechecked when creating the user.

The runtime permission set must cover the actual pool REST classes, pool/slot fields, and scratch-org lifecycle. Add the missing `ScratchOrgInfo.Create` grant. Validate access under the new user; the current pool permission set has only been exercised by an administrator. Preserve the existing pool contract and avoid unrelated permission-set cleanup.

Give the dedicated identity explicit preauthorization in a new permanent ECA. Use the successful certificate/scopes/policy shape from the feasibility test, including `Api,RefreshToken`, enforced IP restrictions, and permission-set API names. Keep the temporary disabled test ECA out of production configuration.

## Runtime integration

Provide one shared Dev Hub authentication policy for the JavaScript test runner, TypeScript E2E utilities, proxy-lab preflight, and scratch-pool administration. Each adapter passes its existing Salesforce CLI execution mechanism so platform-specific executable resolution remains intact.

The configuration contract includes a JWT client ID, username, private-key file or secret-to-file input, login URL, and optional local alias. Treat a partially configured JWT tuple as an error. CI requires JWT even if an alias or the legacy authorization URL is also present. Do not silently fall back to the old refresh-token credential. Error messages identify missing configuration names without including credential values.

Scope `SF_SCRATCH_SIGNUP_CONNECTED_APP=PlatformCLI` and `SF_SCRATCH_SIGNUP_CALLBACK_URL=http://localhost:1717/OauthRedirect` to the scratch-creation child environment. The parent Dev Hub connection must continue using its ECA/JWT identity.

Pin the Salesforce CLI to a version validated for this flow; 2.150.6 passed the Windows feasibility test. Preserve the existing macOS Node 20 isolation for Salesforce CLI. Validate credential redaction handling: never accept a redaction placeholder as an auth URL, and scope any required secret-export opt-in to the child process consuming it. Keep credentials out of logs and test artifacts.

Update workflow credential gates, all real-org jobs, proxy-lab credential transport and documentation together. Container execution must keep TLS verification and the existing corporate CA/proxy path. Use ephemeral files or an appropriately scoped read-only mount for the private key; avoid embedding credentials into a container image or repository file.

## Credential lifecycle — pending final decision

Proposed: keep the private key in a GitHub Actions Secret for this repository, with a 12-month certificate and a documented rotation procedure. Store non-secret identifiers separately. The procedure must specify certificate replacement, secret replacement, verification, recovery after an interrupted rotation, and removal of the obsolete Dev Hub refresh-token dependency.

Do not install a recurring rotation or reminder automation unless the user requests one. Do not commit a generated key, authorization URL, retrieved client secret, or user-specific authentication state.

## Validation and cutover

1. Validate missing/partial JWT configuration, strict CI behavior, local alias behavior, CLI argument construction and secret-safe error handling through relevant unit tests.
2. Validate workflow/container propagation and regression tests affected by the CLI version pin.
3. Create the dedicated identity and permanent ECA within the chosen license constraints; verify JWT login and a Dev Hub query.
4. Under that identity, verify scratch creation through `PlatformCLI`, a scratch API query, export/import into an isolated state directory, and scratch deletion.
5. Exercise the pool lease/finalization/release path and maintenance operations using an isolated test pool. Do not reset or rewrite existing pools merely to pass the smoke test.
6. Check any ownership boundary affecting pre-existing scratch orgs; use an explicit migration step if needed rather than granting broad administrator access.
7. Configure the repository's JWT inputs, run actual real-org CI, and confirm the old Dev Hub authorization URL is no longer a dependency.
8. Document the final app/user setup, configuration locations, operational commands, rotation, and reversal. Record actual validation limits rather than treating source inspection or a local login as CI proof.

## Exclusions

This effort does not change product runtime authentication, log storage, the scratch-pool data model, unrelated dependency versions, or release behavior. Existing snapshot support remains a separate license/permission consideration; the currently configured pools use definition-based creation.

## Planning context

- Format: v1
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 8a6560180fded60f4f7a75ca4cbd61479d06b3f3
- Decisions: DEC-001, DEC-002, DEC-003, DEC-004, DEC-005, DEC-007, DEC-008, DEC-009
