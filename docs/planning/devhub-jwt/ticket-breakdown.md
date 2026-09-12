# JWT migration ticket breakdown

Status: the user approved the six slices and blocking edges on 2026-09-06. All six tickets are published as native sub-issues of #1073 with the `ready-for-agent` label and native blocking dependencies.

Parent specification: https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## Historical decision coverage before drafting

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

Ticket bodies carry only the IDs that affect their own deliverable. Their published acceptance contracts extend the existing specification evidence; they are not recorded as successful verification. The mapping itself records ticket traceability because the source declares no separate `tickets` obligations.

## Runtime correction during T05

DEC-010 adds specification, tickets, and verification obligations for the supported macOS CLI runtime. T05/#1078 owns this correction and its actual CI proof; T06/#1079 inherits the resulting runtime without reopening accepted T01-T04 behavior. The earlier mapping and publication snapshot above describe the original ticket graph.

## Policy extension during T06 - 12 September 2026

DEC-011 supersedes DEC-005: local and CI Dev Hub runtime authentication now require JWT, with no authenticated-alias or cached-account exception. DEC-012 requires durable private operator credentials/journal and explicit recovery after loss of the registered local material. Both decisions declare specification, tickets and verification obligations, mapped to the still-open T06/#1079 acceptance criteria and the current parent specification. Verification is pending for these new requirements; earlier accepted slices and their recorded evidence are preserved.

T06 owns the shared authentication-policy update, public-boundary negative tests, durable operator input/cleanup behavior, an auditable recovery procedure, repeatable local JWT proof and remaining integrated UI/telemetry validation. Preserve the ECA/PlatformCLI authentication separation, existing identity and grants. A separate concrete operator-approved plan is required before active certificate/Secret replacement; the Planning extension alone does not perform or attest that recovery.

## T06 follow-up after PR #1098

DEC-013 maps to the still-open #1079: extend rotation and recovery to Actions and Dependabot in one new PR. Reuse the existing public command test boundary to prove partial-delivery recovery, rollback to both scopes and timestamp drift rejection. Preserve legacy journals and the active credential. The earlier JWT-only/durable-state scope passed actual integrated-main CI and workflow 34721729839; its evidence is separate from this new delta. Dependency PR triage and merge remain excluded.

## Published slices and dependencies

| Ticket | GitHub issue | Delivery | Blocked by |
| --- | --- | --- | --- |
| T01 | [#1074](https://github.com/Electivus/Apex-Log-Viewer/issues/1074) | Run direct validation with shared JWT policy and a usable scratch environment | None |
| T02 | [#1075](https://github.com/Electivus/Apex-Log-Viewer/issues/1075) | Maintain and consume the Scratch Org Pool through JWT without changing its credential contract | #1074 |
| T03 | [#1076](https://github.com/Electivus/Apex-Log-Viewer/issues/1076) | Run JWT-authenticated validation inside the corporate proxy lab | #1074 |
| T04 | [#1077](https://github.com/Electivus/Apex-Log-Viewer/issues/1077) | Reproducibly provision and prove the dedicated minimum-access identity and ECA | None; permanent credentials require the pending operator policy |
| T05 | [#1078](https://github.com/Electivus/Apex-Log-Viewer/issues/1078) | Cut over real-org CI to the dedicated JWT identity and verify the actual workflow paths | #1075, #1076, #1077 |
| T06 | [#1079](https://github.com/Electivus/Apex-Log-Viewer/issues/1079) | Rotate the automation certificate and recover from interrupted credential replacement | #1078 |

T04 uses the native Salesforce CLI and an isolated validation harness, so it does not depend on the application authentication helper from T01. T03 proves a direct validation path in the proxy lab; pool maintenance is not its prerequisite. T05 depends on all runtime and identity paths. T06 uses the active CI identity and therefore depends on T05.

## Delivery boundaries

- T01 includes any necessary small prefactor and proves it through existing direct runner entry points; there is no standalone helper-only ticket.
- Every slice includes the code/configuration, relevant tests, and operator documentation needed to demonstrate its own behavior.
- Code slices may be validated on the effort branch before production cutover. Do not merge a partial strict-JWT migration that leaves active workflow credential gates and runner policy inconsistent. Full CI migration is completed and verified by T05.
- The credential storage and certificate lifetime proposal remains unconfirmed. Parameterized tooling can be implemented; permanent credential creation and production cutover require the operator decision. Do not silently treat a 12-month certificate or GitHub Actions Secret storage as approved.
- Existing snapshots are not a new feature in this effort. Report any relevant license limitation rather than silently changing the configured pool mode.
- This publication creates the approved ticket graph only. Implementation and permanent credential provisioning have not started.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 4a7b254f7024f4add2af006bb0474ca4a40e7fbb
- Decisions: DEC-001, DEC-004, DEC-011, DEC-012, DEC-013
