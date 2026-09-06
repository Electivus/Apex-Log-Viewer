# T06: Rotate the automation certificate and recover interrupted replacement

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Give operators a reproducible way to rotate the active Dev Hub automation certificate/key and recover an interrupted replacement without returning CI to the personal refresh-token mechanism. Demonstrate the procedure against the dedicated identity and active JWT validation path.

## Acceptance criteria

- [ ] The procedure uses the operator-approved storage and validity policy as explicit input and documents ownership, expiry checks, replacement order, and the expected authentication impact during the transition.
- [ ] Replacement key/certificate preparation and ECA credential updates remain separate from runtime permissions; bootstrap operations use the authorized administrative identity.
- [ ] A controlled rotation updates the approved credential store and ECA configuration, then verifies fresh JWT authentication and the existing real-org smoke path without relying on cached tokens.
- [ ] An interrupted replacement has a demonstrated or controlled-test recovery path with explicit prerequisites. Do not assume an old private key can be recovered from a write-only secret store.
- [ ] Invalid or incomplete replacement inputs fail before changing the active app/secret where possible and never trigger fallback to a Dev Hub authorization URL.
- [ ] Keys, replacement artifacts, and tokens stay outside Git, logs, and CI artifacts; obsolete sensitive material is retired or any blocked removal is reported.
- [ ] Existing permission boundaries and scratch/pool authentication remain intact after rotation.
- [ ] Operator documentation is complete enough to perform the next rotation and recover a failure without this conversation. No recurring automation or reminder is installed without a separate request.

### Decision consequences

- `DEC-004`: Maintain a separate operational credential lifecycle for the dedicated Dev Hub identity.
- `DEC-001`: Preserve certificate-backed Dev Hub authentication during rotation and recovery.

## Blocked by

- T05: Cut over real-org CI to the dedicated JWT identity.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 1d20e5a5515ead606f0e0fa0a6e5b78267230f6e
- Decisions: DEC-001, DEC-004
