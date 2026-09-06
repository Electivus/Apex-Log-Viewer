# T03: Run JWT validation inside the corporate proxy lab

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Run the existing real-org validation commands inside the isolated proxy-lab runner using JWT credentials and the shared authentication policy. The container must obtain and use a scratch environment without borrowing a host CLI alias or depending on a Dev Hub refresh-token URL.

## Acceptance criteria

- [ ] The proxy-lab entry point accepts and validates the required JWT inputs and makes them available to the isolated child runner through operation-scoped secret files or an appropriately scoped read-only mount.
- [ ] A direct real-org validation command authenticates the Dev Hub, creates a scratch through `PlatformCLI`, reaches its API, and performs the normal teardown from inside the lab.
- [ ] Missing/partial JWT inputs for a real-org command fail before org mutations; an unrelated non-real-org smoke remains usable without Salesforce credentials.
- [ ] Preflight and the child command use the same authentication rules. The old Dev Hub authorization URL does not remain a fallback for a JWT-required execution.
- [ ] Existing corporate proxy configuration, approved CA trust, TLS verification, and package-signature controls remain enabled. No elevation or security bypass is introduced.
- [ ] Private keys and authorization values are absent from image layers, command logs, and published artifacts; cleanup occurs after success and failure, with explicit reporting if blocked.
- [ ] The CLI version used by the container supports the tested signup/export behavior, and the parent/child environment does not change Dev Hub authentication to `PlatformCLI` accidentally.
- [ ] Existing proxy-lab command and environment tests cover these contracts, and a real proxy-lab smoke records the behavior and any infrastructure limits.
- [ ] Reproducible invocation, credential transport, changed configuration, and reversal are documented.

### Decision consequences

- `DEC-001`: Authenticate isolated real-org validation with Dev Hub JWT.
- `DEC-003`: Preserve the tested Dev Hub/scratch authentication separation inside the container.
- `DEC-005`: Apply strict JWT requirements consistently at the lab boundary.

## Blocked by

- #1074: Run direct validation with JWT-authenticated Dev Hub access.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: bb6a0ecdead02869d823a828c2fe4e462ba0b2b9
- Decisions: DEC-001, DEC-003, DEC-005
