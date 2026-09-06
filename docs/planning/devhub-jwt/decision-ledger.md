# Decision ledger

- Format: v1
- Effort: devhub-jwt

Decision meanings are immutable after a Planning checkpoint. Coverage advances from pending to complete, and evidence may be appended without replacing prior values.

## DEC-001
- Status: active
- Decision: Implement JWT login for the Dev Hub authentication used by automated real-org validation.
- Context: Dependabot triage found real-org E2E runs failing with an expired refresh token. The user explicitly chose JWT as the lasting correction and identified a connected local Dev Hub.
- Rationale: A certificate-backed JWT login removes the dependency on the expiring interactive refresh token that currently blocks validation.
- ADR: none
- Obligations: specification, verification
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none

## DEC-002
- Status: active
- Decision: Validate External Client App JWT login and scratch-org creation/authentication against InsuranceIDO20260313Prod before selecting the migration architecture.
- Context: The user challenged ECA compatibility after the Connected App creation restrictions and explicitly requested a real test using the connected Dev Hub and logged-in Chrome session.
- Rationale: Observed end-to-end behavior is required to resolve the conflict between ECA login support, scratch signup constraints, and the pool authentication contract.
- ADR: none
- Constraints: Use calixto@electivus.com20260313-idoinsurancedemo in org 00DKa00000efWfGMAU for the experiment. Keep production migration decisions pending.
- Obligations: specification, verification
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none
