# Scratch Org Pool

This repository supports a Dev Hub-backed scratch-org pool for Playwright E2E runs. The pool keeps a fixed set of reusable scratch orgs, hands out exclusive leases through an Apex REST API, and now reuses each slot by storing the scratch org's `sfdxAuthUrl` in the Dev Hub.

## What ships in this repo

- Dev Hub metadata under `force-app/main/default/objects/ALV_ScratchOrgPool__c` and `force-app/main/default/objects/ALV_ScratchOrgPoolSlot__c`
- Custom fields on `ScratchOrgInfo` so each scratch org can be traced back to a pool slot
- Lease API classes `ALVScratchPoolService.cls` and `ALVScratchPoolRest.cls`
- Permission set `ALV_ScratchOrgPoolService.permissionset-meta.xml` for the Dev Hub integration user
- E2E helper support in `test/e2e/utils/scratchOrg.ts`
- Operational CLI in `scripts/scratch-pool-admin.js`

## Dev Hub bootstrap

Deploy the metadata to the Dev Hub and assign the permission set to the integration user that will call the pool API.

```bash
sf project deploy start --target-org DevHubElectivus --source-dir force-app
sf org assign permset --target-org DevHubElectivus --name ALV_ScratchOrgPoolService
```

Create or update the pool records:

```bash
pnpm run scratch-pool:bootstrap -- --target-org DevHubElectivus --pool-key alv-e2e --target-size 30
```

Notes:

- When invoking these scripts through `pnpm run`, keep the extra `--` before the script arguments so pnpm forwards flags like `--pool-key` to the script.
- Administrative commands authenticate only with the JWT identity; `SF_DEVHUB_ALIAS` applies to local test runs, not to these commands.

Useful bootstrap overrides:

- `--scratch-duration-days 30`
- `--lease-ttl-seconds 5400`
- `--acquire-timeout-seconds 600`
- `--min-remaining-minutes 120`
- `--seed-version alv-e2e-baseline-v1`
- `--definition-hash <hash>`
- `--provisioning-mode snapshot --snapshot-name <snapshot>`

Pool maintenance:

```bash
pnpm run scratch-pool:list -- --target-org DevHubElectivus --pool-key alv-e2e
pnpm run scratch-pool:reconcile -- --target-org DevHubElectivus --pool-key alv-e2e
pnpm run scratch-pool:prewarm -- --target-org DevHubElectivus --pool-key alv-e2e
pnpm run scratch-pool:disable-slot -- --target-org DevHubElectivus --pool-key alv-e2e --slot-key slot-02 --reason "maintenance"
pnpm run scratch-pool:reset-slot -- --target-org DevHubElectivus --pool-key alv-e2e --slot-key slot-02 --reason "force recreate"
```

After this migration, `reconcile` marks any slot without a stored `sfdxAuthUrl` as `needs_recreate`, so the next lease recreates it once and stores a fresh reusable auth URL.

`prewarm` is the maintenance command to eagerly create every pending scratch org slot instead of waiting for the first E2E worker to trigger recreation. Use `--limit <n>` when you want to warm the pool gradually.

`prewarm` takes a conditional maintenance lease per slot and skips slots that are leased or provisioning, so it is safe while Real Org E2E runs. When a scratch creation fails, prewarm marks that slot `needs_recreate` and stops. If the process is cancelled or times out mid-slot, that slot stays `provisioning` until its 90-minute maintenance lease expires.

`reconcile` refreshes each slot's scratch-org inventory from the Dev Hub and is also safe while Real Org E2E runs. It skips slots that are `leased`, `provisioning` or `repairing`. It writes each slot with a conditional update and skips a slot that changed after it was read. It never moves a `needs_recreate` or `broken` slot back to `healthy`. Skipped slots are listed, each with its reason, in `skippedSlots`. A retired slot returns to service only through recreation: `prewarm` (or the next Pool Lease that lands on it) replaces its scratch org, and `reset-slot` forces that recreation for a slot that is not yet retired.

A lease that expires without being released, whether a Pool Lease or a maintenance lease, is reclaimed the next time an acquire scans the pool. This happens when a job is cancelled, times out or loses its runner. The reclaim retires the environment: the slot becomes `available` and `needs_recreate`, or stays `broken`. It also loses its stored auth URL, gets `LastRunResult__c` set to `lease-expired`, and records the expired lease's state and owner in `LastError__c`. Slot Recovery or the next Pool Lease then recreates the environment, so a scratch org abandoned mid-change never returns to circulation.

## Slot Recovery

The Slot Recovery workflow (`.github/workflows/slot-recovery.yml`) runs `prewarm` for `SF_SCRATCH_POOL_NAME` outside any Real Org E2E run, so a lease almost never waits for scratch creation. It runs after every completed E2E workflow run, whatever its conclusion, hourly, and on manual dispatch. Overlapping triggers collapse into one run at a time. It never runs `reconcile`.

A run fails when prewarm cannot create a scratch org, for example at the Dev Hub's daily signup limit; the next trigger retries the remaining retired slots. A successful prewarm logs the healthy and `needs_recreate` slot counts. To confirm the outcome, dispatch the workflow and check the pool:

```bash
gh workflow run slot-recovery.yml --repo Electivus/Apex-Log-Viewer
node scripts/devhub-local.js run -- corepack pnpm run scratch-pool:list -- --pool-key '<configured pool>'
```

## Authentication model

On the `codex/devhub-jwt` effort branch, administrative commands and consumers use the shared [Dev Hub JWT policy](DEVHUB_JWT.md). Production workflow/credential cutover remains #1078; the current Actions contract below is transitional.

- Dev Hub operations use the ECA client ID, explicit username/login URL, and exactly one private-key input documented in `DEVHUB_JWT.md`. CI requires complete JWT.
- Local E2E consumers (not the administrative commands) may explicitly select an already-authenticated `SF_DEVHUB_ALIAS` only when JWT inputs are absent. A failed selected JWT never falls back.
- Scratch-org reuse uses the slot's stored `sfdxAuthUrl`
- The helper reauthenticates a pooled scratch org with `sf org login sfdx-url`

See [pool maintenance, ownership transition and the isolated validation command](DEVHUB_JWT.md#pool-maintenance-and-independent-consumers) for the current operating procedure and observed cleanup results.

The slot object stores `ScratchAuthUrl__c` as a `LongTextArea`. Treat it as a secret:

- do not expose it in page layouts or admin output
- do not enable field history tracking
- do not log it from Apex, Node, or GitHub Actions
- keep field access restricted to the integration user or admin-only maintenance flows

## Local E2E usage

Set these env vars before running Playwright:

- `SF_SCRATCH_STRATEGY=pool`
- `SF_SCRATCH_POOL_NAME=alv-e2e`
- Complete JWT inputs from `DEVHUB_JWT.md`, or an explicit authenticated local alias with JWT absent

Optional tuning:

- `PLAYWRIGHT_WORKERS=7`
- `PLAYWRIGHT_SHARD=1/4`
- `SF_SCRATCH_POOL_OWNER=<owner-label>`
- `SF_SCRATCH_POOL_LEASE_TTL_SECONDS=5400`
- `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS=600`
- `SF_SCRATCH_POOL_HEARTBEAT_SECONDS=60`
- `SF_SCRATCH_POOL_MIN_REMAINING_MINUTES=120`
- `SF_SCRATCH_POOL_SEED_VERSION=alv-e2e-baseline-v1`
- `SF_SCRATCH_POOL_SNAPSHOT_NAME=<snapshot>`

Example:

```powershell
$env:SF_SCRATCH_STRATEGY = 'pool'
$env:SF_SCRATCH_POOL_NAME = 'alv-e2e'
$env:PLAYWRIGHT_WORKERS = '1'
$env:PLAYWRIGHT_SHARD = '1/4'
pnpm run test:e2e
```

If `SF_SCRATCH_STRATEGY` is unset, the helper automatically switches to pool mode when `SF_SCRATCH_POOL_NAME` is present. The legacy single-scratch flow still works and remains the fallback when the pool is not configured.

In pool mode, each Playwright worker holds one Pool Lease across its consecutive tests, from the first test that requests the org until the worker ends or the first failure ends it and marks the slot `needs_recreate` ([ADR 0006](adr/0006-hold-one-pool-lease-per-test-runner.md)). `PLAYWRIGHT_WORKERS` controls how many workers, each with its own Pool Lease, run at the same time. In legacy single-scratch mode, the Playwright configs force serial execution so parallel tests do not share the same scratch alias.

## GitHub Actions

The Playwright workflow is pool-only in CI. It requires `SF_SCRATCH_POOL_NAME` and all four JWT secrets below, and it fails fast when any input is missing or invalid instead of falling back to the legacy single-scratch path.

Repository secrets for pool mode:

- `SF_DEVHUB_CLIENT_ID`
- `SF_DEVHUB_USERNAME`
- `SF_DEVHUB_LOGIN_URL`
- `SF_DEVHUB_PRIVATE_KEY`

Repository variables for pool mode:

- `SF_SCRATCH_POOL_NAME`
- `SF_SCRATCH_POOL_LEASE_TTL_SECONDS` (optional)
- `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS` (optional)
- `SF_SCRATCH_POOL_HEARTBEAT_SECONDS` (optional)
- `SF_SCRATCH_POOL_MIN_REMAINING_MINUTES` (optional)
- `SF_SCRATCH_POOL_SEED_VERSION` (optional)
- `SF_SCRATCH_POOL_SNAPSHOT_NAME` (optional)
- `PLAYWRIGHT_WORKERS` (optional)
- `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS` (optional; Ubuntu VS Code extension proxy-lab lane)
- `PLAYWRIGHT_RETRIES` (optional)
- `PLAYWRIGHT_TIMEOUT_MS` (optional)
- `PLAYWRIGHT_EXPECT_TIMEOUT_MS` (optional)

When pool mode is active, each Playwright worker holds one Pool Lease across its consecutive tests and reuses the stored `sfdxAuthUrl` for that slot. The repository workflow defaults to `1` Playwright worker; set `PLAYWRIGHT_WORKERS` as an Actions repository variable, or use the `playwright_workers` dispatch input, to run several workers, each with its own Pool Lease, concurrently. The Ubuntu VS Code extension proxy-lab lane can be tuned independently with `PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS` because it runs VS Code/Electron inside Docker.

The workflow intentionally has no workflow-level concurrency group. The Apex pool service locks the pool record while it atomically assigns a free slot, so parallel PR and manual runs can use the configured capacity without sharing an org. When every slot is leased, clients retry until `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS` instead of over-leasing the pool.

## Codex Cloud

Codex Cloud consumers use the same shared JWT inputs for Dev Hub access and the same slot-specific `sfdxAuthUrl` for scratch reuse. Supply JWT inputs through the environment's approved secret mechanism; keep the workflow-owned key/state alive through the final lease release. The dedicated identity is provisioned; see [workflow cutover and recovery](DEVHUB_JWT.md#production-workflow-cutover) for production evidence and ownership constraints.
