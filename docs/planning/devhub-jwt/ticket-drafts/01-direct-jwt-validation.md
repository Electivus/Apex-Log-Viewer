# T01: Run direct validation with JWT-authenticated Dev Hub access

## Parent

https://github.com/Electivus/Apex-Log-Viewer/issues/1073

## What to build

Make the existing direct test-runner entry points authenticate the intended Dev Hub with a shared JWT policy and obtain a usable scratch environment through Salesforce's built-in `PlatformCLI`. A local developer can still select an explicitly authenticated alias when JWT is absent; CI and selected-JWT failures cannot silently fall back to another credential mechanism.

Include any small authentication-policy prefactor within this working path, preserving the existing Salesforce CLI execution adapters. This is the first implementation slice, not a helper-only refactor.

## Acceptance criteria

- [ ] The direct JavaScript runner and TypeScript E2E runner use one authentication policy through their existing execution interfaces.
- [ ] Complete JWT configuration authenticates the configured identity. Missing or partial configuration in CI fails before pool or scratch mutations; the old Dev Hub auth URL and cached aliases do not bypass the JWT requirement.
- [ ] Explicit local alias use remains available when JWT is absent. Invalid selected JWT settings fail visibly without switching identities.
- [ ] A direct scratch workflow uses the tested `PlatformCLI` signup override, reaches the scratch API, and exposes a usable authorization URL that can be imported into an empty CLI state. The Dev Hub itself remains ECA/JWT authenticated.
- [ ] Redaction placeholders and malformed authorization values are rejected. Required credential-export opt-ins are limited to the consuming child process.
- [ ] Errors, logs, and retained test artifacts contain no credential values; temporary key files are removed on success and failure, or a concrete cleanup failure is reported.
- [ ] Existing Windows executable resolution and macOS Salesforce CLI Node 20 isolation remain intact. The documented CLI version supports the tested signup/export behavior.
- [ ] Existing runner/authentication tests cover the observable configuration, failure, and scratch-use contract. A controlled end-to-end smoke through the runner entry point demonstrates the path without relying on a previously cached session.
- [ ] Local JWT/alias usage and the validated command are documented. Production workflow cutover remains owned by #1078; do not merge a half-migrated active CI contract.

### Decision consequences

- `DEC-001`: Authenticate automated Dev Hub access with JWT through the existing direct runners.
- `DEC-003`: Preserve ECA/JWT for the Dev Hub and usable `PlatformCLI` scratch authorization.
- `DEC-005`: Enforce strict JWT in CI while retaining explicit local alias support.

## Blocked by

None (can start immediately).

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: 979e5ded16203ba23c7287ec63e9869aa08e65e5
- Decisions: DEC-001, DEC-003, DEC-005
