# T02: Maintain and consume the Scratch Org Pool through JWT

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Allow a JWT-authenticated operator or runner to maintain and consume the Scratch Org Pool through the existing administrative and lease APIs. Pool records, exportable scratch authorization URLs, concurrency semantics, and independent-runner import remain compatible with the current contract.

## Acceptance criteria

- [ ] Existing pool-administration commands authenticate through the shared policy before accessing the configured pool; local alias use and CI strictness follow the same rules as the direct runners.
- [ ] An isolated test pool can be bootstrapped or selected, prewarmed with a new scratch, reconciled, and inspected through the existing public commands.
- [ ] Scratch creation uses `PlatformCLI` while Dev Hub access remains ECA/JWT. The stored scratch authorization is usable, not a CLI redaction placeholder.
- [ ] A separate runner can acquire the test slot, import its scratch credential, query the scratch, heartbeat, finalize, and release the lease through the established contract.
- [ ] Failures preserve the existing lease/conditional-update rules and produce a recoverable slot state with secret-safe diagnostics.
- [ ] Cleanup and maintenance work for scratchs owned by the configured identity. Any inability to delete pre-existing administrator-owned scratchs is identified precisely with an explicit transition step, without broad privilege expansion or a live-pool reset.
- [ ] No new pool schema, credential format, or cache layout is introduced. Existing pool and slot data remains readable.
- [ ] Relevant pool-command and runner tests prove behavior through the existing public interfaces; an isolated pool lifecycle smoke provides observable evidence and reports all retained resources.
- [ ] Operator documentation identifies JWT inputs, the maintenance validation command, ownership-transition handling, and cleanup results.

### Decision consequences

- `DEC-001`: Apply JWT authentication to the administrative Dev Hub path.
- `DEC-003`: Preserve the pool's scratch signup and authorization export/import contract.
- `DEC-005`: Keep the pool entry points aligned with strict CI JWT policy and explicit local alias use.

## Blocked by

- #1074: Run direct validation with JWT-authenticated Dev Hub access.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: bb6a0ecdead02869d823a828c2fe4e462ba0b2b9
- Decisions: DEC-001, DEC-003, DEC-005
