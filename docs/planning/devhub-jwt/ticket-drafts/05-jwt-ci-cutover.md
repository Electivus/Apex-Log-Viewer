# T05: Cut over real-org CI to the dedicated JWT identity

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Configure the repository's real-org workflows to use the dedicated Dev Hub Automation Identity with JWT, remove the old interactive-auth dependency, and prove the integrated migration through actual CI runs. This is the production cutover point for the direct runner, pool, proxy-lab, and identity slices.

## Acceptance criteria

- [ ] Every real-org workflow credential gate and child environment requires the complete JWT configuration and no longer selects or depends on the legacy Dev Hub authorization URL.
- [ ] Approved credential storage is configured without exposing the private key in repository files, command output, or artifacts. The operator has explicitly supplied the storage policy and certificate lifetime required for permanent provisioning.
- [ ] The selected Salesforce CLI is pinned to the version verified for signup and export behavior; Windows/Linux execution and the existing macOS Node 20 CLI isolation remain aligned with their supported runtime paths.
- [ ] Actual real-org workflow execution succeeds through the relevant direct, pool, telemetry, and proxy-lab paths using the dedicated identity. Provide links and results, and identify any path that could not be validated.
- [ ] Negative workflow-contract coverage proves that absent or partial JWT configuration cannot be bypassed by the old secret, an alias, or redacted placeholder values.
- [ ] Existing pool records and scratch credentials remain usable. Any ownership transition identified by prior slices is applied explicitly without resetting live pools or silently broadening privileges.
- [ ] The obsolete Dev Hub refresh-token credential is no longer an operational dependency; document the removal/cutover steps and verify the dedicated identity in a fresh process or runner.
- [ ] Relevant workflow and script checks pass against the integrated branch. Do not count an expected pre-cutover authentication failure as successful validation.
- [ ] Operational documentation names the configured inputs, owners, verification commands, cleanup outcome, and recovery procedure. Production integration occurs only after the workflow and runner contracts are consistent.

### Decision consequences

- `DEC-001`: Complete the migration of real-org automation away from personal refresh-token based Dev Hub access.
- `DEC-002`: Add actual integrated CI evidence beyond the earlier local feasibility experiment.
- `DEC-003`: Verify the ECA/PlatformCLI separation and preserved pool credentials in the selected CI runtime.
- `DEC-004`: Run production validation with the dedicated identity.
- `DEC-005`: Make JWT mandatory across the real-org workflows without legacy fallback.

## Blocked by

- T02: Maintain and consume the Scratch Org Pool through JWT.
- T03: Run JWT validation inside the corporate proxy lab.
- T04: Provision and prove the dedicated minimum-access Dev Hub identity.

**Operator prerequisite:** the permanent credential-lifecycle decision must be confirmed before cutover.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: bb6a0ecdead02869d823a828c2fe4e462ba0b2b9
- Decisions: DEC-001, DEC-002, DEC-003, DEC-004, DEC-005
