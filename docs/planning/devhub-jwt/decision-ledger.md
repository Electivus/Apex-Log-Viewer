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
  - specification: complete
  - verification: complete
- Evidence:
  - specification: docs/planning/devhub-jwt/eca-jwt-experiment.md: Scope and acceptance
  - verification: docs/planning/devhub-jwt/eca-jwt-experiment.md: Observed results; live ECA JWT login, scratch signup override, API queries, cross-home credential reimport and disabled-app verification on 2026-09-06

## DEC-003
- Status: active
- Decision: Authenticate the Dev Hub with JWT through an External Client App and create scratch orgs through the Salesforce built-in PlatformCLI signup override.
- Context: The live ECA test passed Dev Hub JWT login and scratch creation plus credential reimport with the PlatformCLI override; default ECA signup failed with C-1016. The user selected the validated combination.
- Rationale: Remove the long-lived Dev Hub refresh-token dependency while preserving the scratch-pool SFDX authorization contract.
- ADR: none
- Constraints: Update and pin the CI Salesforce CLI to a version that supports the tested signup override and handle secret redaction correctly.
- Obligations: specification, verification
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none

## DEC-004
- Status: active
- Decision: Prepare a dedicated automation user for permanent Dev Hub JWT authentication.
- Context: The user chose a dedicated automation identity rather than retaining the personal account used for the feasibility experiment.
- Rationale: Give the automation a separate lifecycle and permissions appropriate to its Dev Hub and pool responsibilities.
- ADR: none
- Constraints: Determine available licenses and the required permissions before provisioning.
- Obligations: specification, verification
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none

## DEC-005
- Status: active
- Decision: Require JWT credentials for Dev Hub authentication in CI while preserving local use of an authenticated alias.
- Context: The user rejected a temporary fallback to the old SF_DEVHUB_AUTH_URL in CI.
- Rationale: Fail explicitly on missing JWT configuration and prevent silent reuse of the expiring interactive refresh-token mechanism.
- ADR: none
- Obligations: specification, verification
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none

## DEC-006
- Status: superseded
- Superseded by: DEC-007
- Decision: Associate the dedicated automation user and External Client App with a shared mailbox supplied by the user.
- Context: The user selected a shared mailbox instead of the personal address found in the feasibility-test org.
- Rationale: Keep contact and recovery ownership with the automation team.
- ADR: none
- Constraints: The exact mailbox address is pending and must be provided before provisioning.
- Obligations: specification, verification
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none

## DEC-007
- Status: active
- Decision: Use apex-log-viewer-ci@electivus.com as the dedicated automation contact and initial username candidate.
- Context: The user authorized any address under electivus.com because domain aliases deliver to the existing mailbox.
- Rationale: Provide a purpose-specific automation identity without waiting for a separately provisioned mailbox.
- ADR: none
- Constraints: If the Salesforce username is already taken globally, generate a unique address under electivus.com; the contact address remains the purpose-specific alias.
- Obligations: specification, verification
- Supersedes: DEC-006
- Coverage:
  - specification: pending
  - verification: pending
- Evidence:
  - specification: none
  - verification: none
