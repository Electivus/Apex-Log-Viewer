# ECA JWT feasibility experiment

Date: 2026-09-06. Performed against the user-selected Dev Hub, using Salesforce CLI 2.150.6, `@salesforce/core` 9.1.7, Node 24.19.0, Windows, and Metadata API 67.0.

## Scope and acceptance

DEC-002 required live evidence before selecting an authentication architecture. The experiment used a new temporary External Client App, a self-signed RSA-2048 certificate valid for two days, and an empty permission set assigned only to the selected test user. CLI authentication used separate temporary home directories; the existing interactive authorization remained usable.

Acceptance covered JWT authentication to the Dev Hub, a live API query, scratch-org creation and authentication, and exporting/importing the scratch authorization in a second empty CLI state directory. This is a feasibility test, not validation of the repository's CI or a dedicated user's permissions.

## Observed results

| Step | Result |
| --- | --- |
| Create ECA and OAuth metadata through the Metadata API | Passed after dry-run validation |
| Preauthorize the selected user through a dedicated permission set | Passed |
| JWT login with only `Api` scope | Rejected: Salesforce also requires `RefreshToken` scope |
| JWT login with `Api,RefreshToken` scopes | Passed; Dev Hub state has a private-key reference and no refresh token |
| Query the Dev Hub Organization object through JWT authentication | Passed |
| Default scratch signup inheriting the ECA | Failed with `C-1016` |
| Scratch signup with the CLI's `PlatformCLI` override | Passed |
| Query the scratch Organization object | Passed |
| Export scratch authorization and import it into another empty CLI home | Passed; a query from that independent authorization also passed |
| Scratch authentication shape | Uses `PlatformCLI` and a refresh token; no private-key reference |
| Delete the test scratch org | Passed; final Dev Hub limit showed no active scratch orgs |
| Disable the temporary ECA | Passed; a new JWT login was rejected because the app or OAuth plugin was disabled |

The failed default signup returned an actionable CLI message stating that the signup service cannot replicate an ECA into the new scratch org. The same message prescribed these environment variables, which were tested successfully:

```powershell
$env:SF_SCRATCH_SIGNUP_CONNECTED_APP = 'PlatformCLI'
$env:SF_SCRATCH_SIGNUP_CALLBACK_URL = 'http://localhost:1717/OauthRedirect'
```

This uses Salesforce's existing built-in Connected App for scratch signup; it does not require creating a new classic Connected App in the Dev Hub. The Dev Hub remains authenticated with JWT through the ECA.

## Configuration details established by the test

- ECA distribution: `Local`; OAuth scope: `Api,RefreshToken`.
- The PEM certificate is stored in `ExtlClntAppGlobalOauthSettings.certificate`.
- OAuth policy: `AdminApprovedPreAuthorized`, `Enforce` IP restrictions, `Zero` refresh-token policy, 15-minute opaque-token session timeout.
- The server requires a permission-set **API name** in `commaSeparatedPermissionSet`. An older local metadata schema incorrectly described IDs; a dry-run using the ID failed before any policy change.
- CLI 2.150.6 redacts authentication values by default, including `sfdxAuthUrl` in verbose display. The export/import proof scoped `SF_TEMP_SHOW_SECRETS=true` to the exporting child process, consumed the value privately, and wrote redacted evidence. A nonempty redaction placeholder is not a valid authorization URL.
- The repository currently defaults to CLI 2.136.8. The signup override and output handling must be validated with the version selected for CI; this experiment establishes 2.150.6 as a working local version.

## Evidence and limits

The local temporary experiment directory contains a Python harness and sanitized JSON results for validation, deployment, JWT login, queries, both signup paths, credential reimport, deletion, and disabled-app verification. Credentials and retrieved consumer secrets must not be copied into the repository.

The experiment created one successful one-day scratch org and released its active capacity after testing. The temporary ECA remains disabled. The temporary permission set grants no additional system or object privileges. No existing app was modified.

Deletion of temporary local credential files was rejected by the execution approval policy, including a narrower attempt naming only the exact generated files. Those files remain local; the associated ECA was disabled and the scratch org deleted. No temporary credentials were committed.

Not yet validated: a dedicated automation user, Linux/macOS CI runtime behavior, actual pool maintenance with JWT, proxy-lab behavior, and migration of GitHub secrets/workflows. Certificate rotation and permanent app ownership remain design decisions.

## Planning context

- Format: v1
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 26451ddb8f753506492fc0b76556fc924efaa89d
- Decisions: DEC-002
