---
status: accepted
---

# Separate Dev Hub and scratch-org authentication

Authenticate the Dev Hub Automation Identity with certificate-backed JWT through an External Client App, while using Salesforce's built-in `PlatformCLI` for scratch signup and retaining exportable scratch authorization URLs. The [live feasibility test](../planning/devhub-jwt/eca-jwt-experiment.md) established that inheriting the ECA during scratch signup fails with `C-1016`, whereas this combination supports creation, API access, and authorization import from an independent runner. This deliberately preserves the Scratch Org Pool's credential contract and avoids requiring a newly created classic Connected App or depending on a personal Dev Hub refresh token.
