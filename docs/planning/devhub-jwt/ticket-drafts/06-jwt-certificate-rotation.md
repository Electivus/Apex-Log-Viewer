# T06: Rotate the automation certificate and recover interrupted replacement

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Give operators a reproducible way to rotate the active Dev Hub automation certificate/key and recover an interrupted replacement without returning CI to the personal refresh-token mechanism. Demonstrate the procedure against the dedicated identity and active JWT validation path.

The 12 September 2026 policy extension also requires JWT-only local validation and durable private operator state. Remove the former local Dev Hub alias exception and explicitly handle the loss of the registered temporary key/journal without inventing history or replacing the approved identity.

## Acceptance criteria

- [ ] The procedure uses the operator-approved storage and validity policy as explicit input and documents ownership, expiry checks, replacement order, and the expected authentication impact during the transition.
- [ ] Replacement key/certificate preparation and ECA credential updates remain separate from runtime permissions; bootstrap operations use the authorized administrative identity.
- [ ] A controlled rotation updates the approved credential store and ECA configuration, then verifies fresh JWT authentication and the existing real-org smoke path without relying on cached tokens.
- [ ] An interrupted replacement has a demonstrated or controlled-test recovery path with explicit prerequisites. Do not assume an old private key can be recovered from a write-only secret store.
- [ ] Invalid or incomplete replacement inputs fail before changing the active app/secret where possible and never trigger fallback to a Dev Hub authorization URL.
- [ ] Keys, replacement artifacts, and tokens stay outside Git, logs, and CI artifacts; obsolete sensitive material is retired or any blocked removal is reported.
- [ ] Existing permission boundaries and scratch/pool authentication remain intact after rotation.
- [ ] Operator documentation is complete enough to perform the next rotation and recover a failure without this conversation. No recurring automation or reminder is installed without a separate request.
- [ ] JavaScript/TypeScript runners, pool commands and proxy-lab entry points require complete JWT locally and in CI. Missing, partial or invalid JWT fails before Dev Hub or pool mutations despite an explicit alias, cached account or legacy authorization URL; public-boundary tests prove this behavior.
- [ ] The local operator key, certificate, identity journal and input references use private durable per-user storage outside Git, temporary roots and synchronized folders. Scoped WSL/container transport and normal test cleanup preserve the durable state and do not put credentials in images or output.
- [ ] Lost local material has an auditable recovery plan for the same ECA/client ID, dedicated user and grants. Missing historical evidence and unavailable rollback remain explicit; tests reject fabricated ownership or unsafe active writes. A concrete operator-approved plan precedes any active credential replacement.
- [ ] Repeatable local validation proves the dedicated JWT identity from isolated CLI state using the durable operator inputs. PlatformCLI scratch signup/import and separate administrator bootstrap remain supported; neither is treated as a personal Dev Hub fallback.
- [ ] Current UI failures, telemetry validation and actual integrated-main acceptance remain required. Prior JWT/pool receipts and local diagnostic success are not represented as a passing complete workflow or verification of the new policy.

### Actions and Dependabot follow-up

- [ ] An explicit dual-store policy updates the private-key Secret in Actions and Dependabot; all four JWT inputs are inventoried per scope and non-key values remain unchanged.
- [ ] Existing Actions-only state can be explicitly upgraded for the same repository; a downgrade or different repository fails before active writes.
- [ ] Each pending/confirmed delivery is journaled. Controlled public-command tests cover failure before and after either delivery, forward resumption, drift rejection and completion without repeated writes.
- [ ] Rollback restores the retained previous key to both selected scopes even when the old lifecycle was Actions-only. Lost-material plans bind both inventories and retain unavailable rollback and unknown history.
- [ ] Operator documentation describes the new policy, partial failures and actual CI verification for both scopes. This code follow-up does not rotate the current credential or merge dependency PRs.

### Decision consequences

- `DEC-004`: Maintain a separate operational credential lifecycle for the dedicated Dev Hub identity.
- `DEC-001`: Preserve certificate-backed Dev Hub authentication during rotation and recovery.
- `DEC-011`: Replace the old local-alias exception with mandatory JWT across local and CI Dev Hub entry points.
- `DEC-012`: Preserve durable private operator state and provide auditable recovery when the local key/journal is unavailable.
- `DEC-013`: Keep Actions and Dependabot private-key delivery consistent across rotation and recovery.

## Blocked by

- #1078: Cut over real-org CI to the dedicated JWT identity.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 915e9ffa71d925fe63f6d2e1037f172d0ba85e50
- Decisions: DEC-001, DEC-004, DEC-011, DEC-012
