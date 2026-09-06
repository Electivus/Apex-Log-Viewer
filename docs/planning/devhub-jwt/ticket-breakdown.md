# JWT migration ticket breakdown

Status: the user approved the six slices and blocking edges on 2026-09-06; ready for tracker publication.

Parent specification: https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## Decision coverage before drafting

The source ledger declares specification and verification obligations, but no `tickets` obligations. Preserve those checkpointed meanings and IDs. The mapping below gives delivery traceability without inventing new decisions or claiming that a published ticket constitutes completed verification. No active source decision requires a separate mandatory ticket solely to satisfy a `tickets` gate.

| Active decision | Declared obligations | Proposed delivery | Why no separate formal ticket obligation is added |
| --- | --- | --- | --- |
| DEC-001 | specification, verification | T01, T02, T03, T05 | The source declares behavior and verification obligations; their implementation is divided across these complete operational paths. |
| DEC-002 | specification, verification | Prior completed evidence; T04 and T05 consume it | The required feasibility experiment is complete. Do not create a ticket to repeat it; validate the new identity and implementation separately. |
| DEC-003 | specification, verification | T01, T02, T03, T05 | The same authentication separation affects several complete execution paths and does not require a new architectural decision. |
| DEC-004 | specification, verification | T04, T05, T06 | Identity setup, production use, and rotation are distinct observable deliveries of the same decision. |
| DEC-005 | specification, verification | T01, T02, T03, T05 | Authentication policy is implemented once and exercised through its affected entry points. |
| DEC-007 | specification, verification | T04 | The contact and username rule belongs to identity provisioning, not an artificial standalone ticket. |
| DEC-008 | none; applicability complete | No ticket | PR-triage cancellation is an exclusion and creates no implementation work. |
| DEC-009 | specification, verification | T04 | License fallback is part of the dedicated-identity proof. |

Ticket bodies will carry only the IDs that affect their own deliverable. Their acceptance contracts can extend the existing specification evidence after publication; they must not be recorded as successful verification. The mapping itself records ticket traceability because the source declares no separate `tickets` obligations.

## Proposed slices and dependencies

| Ticket | Delivery | Blocked by |
| --- | --- | --- |
| T01 | Run direct validation with shared JWT policy and a usable scratch environment | None |
| T02 | Maintain and consume the Scratch Org Pool through JWT without changing its credential contract | T01 |
| T03 | Run JWT-authenticated validation inside the corporate proxy lab | T01 |
| T04 | Reproducibly provision and prove the dedicated minimum-access identity and ECA | None; permanent credentials require the pending operator policy |
| T05 | Cut over real-org CI to the dedicated JWT identity and verify the actual workflow paths | T02, T03, T04 |
| T06 | Rotate the automation certificate and recover from interrupted credential replacement | T05 |

T04 uses the native Salesforce CLI and an isolated validation harness, so it does not depend on the application authentication helper from T01. T03 proves a direct validation path in the proxy lab; pool maintenance is not its prerequisite. T05 depends on all runtime and identity paths. T06 uses the active CI identity and therefore depends on T05.

## Delivery boundaries

- T01 includes any necessary small prefactor and proves it through existing direct runner entry points; there is no standalone helper-only ticket.
- Every slice includes the code/configuration, relevant tests, and operator documentation needed to demonstrate its own behavior.
- Code slices may be validated on the effort branch before production cutover. Do not merge a partial strict-JWT migration that leaves active workflow credential gates and runner policy inconsistent. Full CI migration is completed and verified by T05.
- The credential storage and certificate lifetime proposal remains unconfirmed. Parameterized tooling can be implemented; permanent credential creation and production cutover require the operator decision. Do not silently treat a 12-month certificate or GitHub Actions Secret storage as approved.
- Existing snapshots are not a new feature in this effort. Report any relevant license limitation rather than silently changing the configured pool mode.
- No implementation or public child issue has been created by this drafting step.
