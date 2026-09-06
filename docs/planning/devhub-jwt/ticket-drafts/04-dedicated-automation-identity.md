# T04: Provision and prove the dedicated minimum-access Dev Hub identity

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Provide reproducible provisioning for the Dev Hub Automation Identity and its permanent ECA, then prove that the selected minimum-access license/profile can perform the required scratch and pool operations. Use the existing authorized administrator only for bootstrap, and use native Salesforce CLI/API behavior to validate the new identity independently of the application authentication helper.

## Acceptance criteria

- [ ] Provisioning checks the target org, current license capacity, existing user/app state, and username uniqueness; it can resume or rerun without creating duplicate identities or changing unrelated apps.
- [ ] The user/contact follows the authorized purpose-specific `electivus.com` alias rule. A globally occupied username receives a unique candidate in that domain.
- [ ] Salesforce Integration with the minimum API-only profile and the appropriate permission set license is tried first. Unsupported required Dev Hub behavior triggers the authorized minimum-access Salesforce fallback, with the compatibility evidence recorded.
- [ ] Runtime permissions include the required scratch lifecycle grants, including `ScratchOrgInfo.Create`, pool/slot fields, and Apex REST class access. General metadata administration and System Administrator are not assigned to the runtime user.
- [ ] The ECA uses certificate-backed JWT, the tested scopes and enforced IP policy, and explicit permission-set preauthorization using the API names accepted by live metadata validation.
- [ ] From isolated CLI state, the dedicated identity logs in with JWT, queries the intended Dev Hub, creates a scratch through `PlatformCLI`, queries and exports/imports it, and deletes it.
- [ ] The same identity reaches the required pool REST/data interfaces under its actual permissions. Ownership or snapshot-related license limits are reported precisely and do not silently change the configured pool mode.
- [ ] Bootstrap scripts accept explicit credential-lifecycle inputs; they do not assume the unconfirmed storage policy or certificate validity. A short-lived controlled test may prove compatibility, but permanent credential provisioning waits for the operator decision.
- [ ] Setup, chosen license/profile, grants, changed settings, ownership, recovery, and teardown are documented without committing keys, consumer secrets, tokens, or auth URLs. Temporary resources and any blocked cleanup are reported.

### Decision consequences

- `DEC-002`: Consume the completed ECA feasibility evidence and validate the new identity separately.
- `DEC-004`: Establish a dedicated runtime identity distinct from the administrator bootstrap account.
- `DEC-007`: Apply the agreed contact/username rule during provisioning.
- `DEC-009`: Demonstrate the minimum Integration candidate or the authorized minimum Salesforce fallback.

## Blocked by

None (parameterized provisioning and a controlled identity proof can start independently).

**Operator prerequisite:** confirm permanent credential storage and certificate lifetime before creating permanent credentials. The discussed GitHub Actions Secret and 12-month certificate remain proposals.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 1d20e5a5515ead606f0e0fa0a6e5b78267230f6e
- Decisions: DEC-002, DEC-004, DEC-007, DEC-009
