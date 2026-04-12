# CLI Real-Org E2E Design

Date: 2026-04-12
Status: Approved design, pending written-spec review

## Summary

Add a first real-org end-to-end test suite for the standalone `apex-log-viewer` binary.

This first slice covers only:

- `logs sync`
- `logs status`
- `logs search`

The suite must provision and clean scratch orgs using the same `single` and `pool` strategies already used by the VS Code extension E2E flow. It must run in GitHub Actions as part of the repository's existing real-org workflow surface.

## Goals

- Validate the standalone CLI binary against a real Salesforce scratch org.
- Reuse the existing scratch-org lifecycle and real-org helper code instead of creating a second provisioning stack.
- Exercise the real local-first flow for logs:
  - create or lease scratch org
  - seed a real Apex log in that org
  - run CLI `logs sync`
  - verify CLI `logs status`
  - verify CLI `logs search`
- Add the new suite to GitHub Actions now, not as a later follow-up.

## Non-Goals

- Do not cover `app-server --stdio` in this first delivery.
- Do not add CLI coverage for `debug flags` or `debug levels`.
- Do not replace the existing Rust fixture-based smoke tests.
- Do not redesign the existing Playwright extension E2E suite.
- Do not introduce a second scratch-org contract or a separate CI secret model.

## Current State

- The repo already has real-org E2E infrastructure for the VS Code extension in `test/e2e/`.
- Scratch org provisioning and cleanup are already implemented in `test/e2e/utils/scratchOrg.ts`.
- Real-org log seeding already exists in `test/e2e/utils/seedLog.ts`.
- The standalone CLI already has fixture-based smoke tests in `crates/alv-cli/tests/cli_smoke.rs`.
- The current GitHub Actions real-org workflow is `.github/workflows/e2e-playwright.yml`.

The gap is that the standalone binary does not yet have a real-org suite. Today the CLI is validated with fixtures, while the extension is the only surface using scratch orgs in E2E.

## Options Considered

### Option 1: Reuse `@playwright/test` as the CLI E2E runner without browser automation

Create a new Playwright-based suite for the CLI that uses Playwright only for:

- worker-scoped fixtures
- retries
- artifact management
- CI-friendly reporting

No browser, Electron, or VS Code host would be launched by this suite.

Pros:

- Reuses the existing real-org fixture model with minimal new infrastructure.
- Keeps the scratch-org lifecycle in one place.
- Matches the extension E2E operational model, including worker-scoped org leases.
- Fits naturally into the existing real-org GitHub Actions workflow.

Cons:

- Uses Playwright as a generic runner, which is slightly unconventional.

### Option 2: Build a second real-org harness directly in Rust tests

Add real-org tests next to `crates/alv-cli/tests/cli_smoke.rs` and provision scratch orgs from a separate helper path.

Pros:

- Keeps CLI tests physically close to the Rust binary.

Cons:

- Would duplicate scratch-org and seeding behavior already solved in TypeScript.
- Harder to share CI fixtures and operational logic with the extension E2E system.
- More cross-runtime glue for provisioning, cleanup, and diagnostics.

### Option 3: Create a Jest or plain Node runner for CLI real-org tests

Use Node to provision orgs and invoke the binary, but without Playwright fixtures.

Pros:

- Simpler than introducing browser semantics.

Cons:

- Reinvents fixture lifecycle behavior already standardized in Playwright.
- Weaker alignment with the existing E2E shape in this repo.

## Decision

Use Option 1.

The first CLI real-org suite will use `@playwright/test` as a worker-aware E2E runner only. It will not launch any browser. This preserves the proven scratch-org contract from the extension E2E suite while keeping the target surface correctly focused on the standalone CLI binary.

## Detailed Design

### Test Architecture

Add a new CLI-specific E2E surface under `test/e2e/cli/`:

- `test/e2e/cli/fixtures/alvCliE2E.ts`
- `test/e2e/cli/specs/logs.e2e.spec.ts`
- `test/e2e/cli/utils/cli.ts`

The new fixture layer will reuse existing helpers where possible:

- scratch provisioning from `test/e2e/utils/scratchOrg.ts`
- Salesforce CLI resolution from `test/e2e/utils/sfCli.ts`
- log seeding and cleanup from `test/e2e/utils/seedLog.ts`
- temporary workspace creation from `test/e2e/utils/tempWorkspace.ts`

The CLI suite will not depend on:

- `launchVsCode()`
- Electron
- webviews
- any UI helper

### Fixture Model

The new `alvCliE2E` fixture will mirror the extension fixture pattern:

- Worker-scoped scratch lease state:
  - acquire via `ensureScratchOrg()`
  - keep lease health assertions around each test
  - release with the same success/failure metadata already used by extension E2E
- Worker-scoped `scratchAlias`
- Per-test `workspacePath`
- Per-test log reset and seeding
- Per-test `runCli(...)` helper for invoking the standalone binary inside the temp workspace

The fixture contract should expose at least:

- `scratchAlias`
- `workspacePath`
- `seededLog`
- `runCli(args, options?)`

`seededLog` must include:

- `marker`
- `logId`

That marker becomes the stable assertion target for the `logs search` scenario.

### CLI Binary Resolution

The CLI suite must execute the standalone `apex-log-viewer` binary produced from the current checkout.

For the first version:

- build the binary through the existing runtime build path, starting from `npm run build:runtime`
- resolve the local binary from the current workspace build output
- fail early with a clear message if the binary is missing

The suite should not exercise the extension-bundled runtime path. It must directly test the standalone binary built from the current checkout.

### Workspace Model

Each test gets a fresh temporary workspace produced by `createTempWorkspace()` with:

- `.sf/config.json` pointing at the leased scratch org
- any workspace-local settings needed by shared helpers

Even though the standalone CLI does not require VS Code settings, reusing the same temp-workspace helper keeps the local cache layout and target-org setup aligned with the existing E2E ecosystem.

### Initial Scenarios

The first spec file will contain three scenarios.

### Scenario 1: `logs sync --json`

Flow:

1. Lease or create a scratch org through the standard helper.
2. Clear org Apex logs before seeding for deterministic setup.
3. Seed one fresh Apex log and capture its `marker` and `logId`.
4. Run:

   `apex-log-viewer logs sync --json --target-org <scratchAlias>`

Assertions:

- process exit code is `0`
- stdout parses as JSON
- `status` is `success`
- `target_org` resolves to the scratch username
- `downloaded >= 1`
- `last_synced_log_id` is present
- `apexlogs/.alv/sync-state.json` exists in the temp workspace

### Scenario 2: `logs status --json`

Precondition:

- run `logs sync` first within the same temp workspace

Flow:

1. Execute:

   `apex-log-viewer logs status --json --target-org <scratchAlias>`

Assertions:

- process exit code is `0`
- stdout parses as JSON
- `has_state` is `true`
- `downloaded_count >= 1`
- `last_synced_log_id` is present
- `log_count >= 1`

### Scenario 3: `logs search --json`

Precondition:

- run `logs sync` first within the same temp workspace
- use the marker created by the seed step

Flow:

1. Execute:

   `apex-log-viewer logs search --json --target-org <scratchAlias> <marker>`

Assertions:

- process exit code is `0`
- stdout parses as JSON
- `query` matches the marker
- `matches` contains at least one entry
- one match refers to the seeded `logId`
- `pending_log_ids` is empty for the seeded log path

### Failure Diagnostics

The CLI E2E suite should preserve the same debugging posture as the extension E2E suite:

- keep temp workspace artifacts on failure
- capture stdout and stderr from the CLI process
- attach artifacts to Playwright output directories
- make failure messages explicit about whether the failure came from:
  - scratch-org provisioning
  - seed log creation
  - CLI execution
  - JSON parsing
  - filesystem state verification

### Command and Config Surface

Add a dedicated command in `package.json`:

- `test:e2e:cli`

The CLI E2E runner should build the local CLI runtime with `npm run build:runtime` only when the local CLI binary is missing.

Add a dedicated Playwright config for the CLI suite, separate from the extension suite, so that:

- CLI artifacts land in a separate output root
- CLI specs can evolve independently from browser/Electron specs
- future CLI real-org scenarios can be added without touching the extension E2E config

### CI Integration

Integrate the CLI real-org suite into `.github/workflows/e2e-playwright.yml`.

First-version approach:

- keep using the existing real-org workflow
- reuse the same required secret and pool variables
- run the CLI suite in that workflow before the extension Playwright suite
- keep the current scratch-org contract unchanged

This keeps the repository on one real-org workflow path instead of splitting configuration across multiple workflows before the CLI suite has stabilized.

### Documentation Changes

Update at least:

- `docs/TESTING.md`
- `docs/CI.md`

Document:

- the new `npm run test:e2e:cli` command
- its scratch-org requirements
- the fact that it targets the standalone binary directly
- where it runs in GitHub Actions

### Test Strategy

Use TDD for the implementation:

1. Add the new CLI real-org runner/config path with a failing first spec.
2. Verify it fails for the expected missing-fixture or missing-runner reason.
3. Add the minimal fixture and helper code to run the binary.
4. Make the first `logs sync` test pass.
5. Add `status` and `search` scenarios one by one.
6. Wire the suite into CI after local execution is stable.

Keep the existing fixture-based Rust smoke tests unchanged. The new suite complements them by validating real-org behavior rather than replacing them.

### Risks and Mitigations

#### Risk: scratch-org flakiness or pool lease issues

Mitigation:

- reuse the already-hardened `ensureScratchOrg()` path
- preserve worker-scoped lease ownership semantics
- fail with explicit provisioning errors

#### Risk: real-org search timing races after seed

Mitigation:

- use the existing `seedApexLog()` helper that already waits for a newly created log ID
- only run `search` after a successful `sync`

#### Risk: duplicate infrastructure between extension E2E and CLI E2E

Mitigation:

- reuse existing helpers first
- create only a thin CLI-specific invocation helper

#### Risk: CI runtime expansion

Mitigation:

- keep the first suite to three scenarios only
- reuse the existing workflow instead of creating a new one
- keep the CLI run ahead of the heavier extension suite for earlier failure visibility

### Acceptance Criteria

This design is complete when the implementation delivers all of the following:

- a standalone CLI real-org E2E suite for `logs sync`, `logs status`, and `logs search`
- scratch-org provisioning and cleanup via the same `single` and `pool` model as extension E2E
- direct execution of the local `apex-log-viewer` binary
- a dedicated npm command for local execution
- integration into the existing GitHub Actions real-org workflow
- updated developer documentation for local and CI usage

### Out of Scope Follow-Ups

Potential later follow-ups, intentionally excluded from this first slice:

- real-org coverage for `app-server --stdio`
- CLI-backed `debug flags` support
- CLI-backed `debug levels` support
- splitting CLI real-org validation into its own dedicated GitHub Actions workflow if scale later justifies it
