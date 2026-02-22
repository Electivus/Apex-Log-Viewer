# Faster test runs (plan)

Date: 2026-02-22

## Context

Local development and CI runs were slowed down by repeated work, especially:

- Re-downloading and re-unzipping VS Code test binaries (`.vscode-test/`)
- Re-installing VS Code dependency extensions for integration tests
- E2E flakiness/overhead from creating and deleting a scratch org per test

The goal is to keep correctness while reducing the “setup tax” so rerunning tests is cheap.

## Goals

- Make `npm run test:*` faster for local iterative runs
- Avoid deleting cached VS Code test installs by default
- Cache integration dependency extensions between runs
- Keep a clean “user data” directory per run to avoid state leakage
- Make E2E runs more stable by reusing a scratch org within a run
- Keep CI deterministic (explicit build steps and coverage where expected)

## Non-goals

- Redesign the extension’s runtime behavior
- Remove existing test coverage
- Introduce CI-only behavior that can’t be reproduced locally

## Proposed changes

### 1) VS Code test caching (integration/unit runner)

- Keep `.vscode-test/` by default instead of deleting it every run
- Add an explicit “clean everything” option (`--force` / `test:clean:all`)
- Use a fixed cache path for `@vscode/test-electron` downloads

Expected impact:

- Big win for local runs (no repeated VS Code download)
- CI can still start from a clean slate if desired

### 2) Dependency extension caching (integration tests)

- Use a shared extensions cache directory under `.vscode-test/extensions`
- Skip re-install if the extension is already present
- Provide an override to force reinstall (env/flag) when debugging

Expected impact:

- Cuts minutes off repeated `npm run test:integration` runs

### 3) Reduce default “pretest” work locally

- Avoid redundant “clean + compile” in `pretest` when scripts already build
- Make CI do the explicit compile step so it remains strict

Expected impact:

- Faster `npm run test:unit` / `test:integration` for local iteration

### 4) E2E stability + speed

- Reuse the scratch org for the full Playwright worker run (worker-scoped fixture)
- Add a readiness probe to wait until Tooling API is responsive
- Hide/close the auxiliary (right) sidebar in VS Code to reduce UI flakiness

Expected impact:

- Large speedup for `npm run test:e2e` (avoid per-test scratch provisioning)
- Reduced flake rate when scratch org is still “warming up”

## Validation

- `npm run compile`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`

## Rollback plan

If any of these changes cause regressions, the rollback is straightforward:

- Restore the previous cleanup behavior for `.vscode-test/`
- Disable dependency extension caching and revert to per-run installs
- Revert E2E fixture scope to per-test scratch org creation
