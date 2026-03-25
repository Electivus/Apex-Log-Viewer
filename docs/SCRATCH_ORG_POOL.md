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
npm run scratch-pool:bootstrap -- --target-org DevHubElectivus --pool-key alv-e2e --target-size 21
```

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
npm run scratch-pool:list -- --target-org DevHubElectivus --pool-key alv-e2e
npm run scratch-pool:reconcile -- --target-org DevHubElectivus --pool-key alv-e2e
npm run scratch-pool:prewarm -- --target-org DevHubElectivus --pool-key alv-e2e
npm run scratch-pool:disable-slot -- --target-org DevHubElectivus --pool-key alv-e2e --slot-key slot-02 --reason "maintenance"
npm run scratch-pool:reset-slot -- --target-org DevHubElectivus --pool-key alv-e2e --slot-key slot-02 --reason "force recreate"
```

After this migration, `reconcile` marks any slot without a stored `sfdxAuthUrl` as `needs_recreate`, so the next lease recreates it once and stores a fresh reusable auth URL.

`prewarm` is the maintenance command to eagerly create every pending scratch org slot instead of waiting for the first E2E worker to trigger recreation. Use `--limit <n>` when you want to warm the pool gradually.

## Authentication model

The pool no longer depends on a custom Salesforce OAuth app.

- Dev Hub operations use `SF_DEVHUB_AUTH_URL` or an already-authenticated `SF_DEVHUB_ALIAS`
- Scratch-org reuse uses the slot's stored `sfdxAuthUrl`
- The helper reauthenticates a pooled scratch org with `sf org login sfdx-url`

The slot object stores `ScratchAuthUrl__c` as a `LongTextArea`. Treat it as a secret:

- do not expose it in page layouts or admin output
- do not enable field history tracking
- do not log it from Apex, Node, or GitHub Actions
- keep field access restricted to the integration user or admin-only maintenance flows

## Local E2E usage

Set these env vars before running Playwright:

- `SF_SCRATCH_STRATEGY=pool`
- `SF_SCRATCH_POOL_NAME=alv-e2e`
- `SF_DEVHUB_AUTH_URL=<devhub-sfdx-auth-url>`

Optional tuning:

- `PLAYWRIGHT_WORKERS=7`
- `SF_SCRATCH_POOL_OWNER=<owner-label>`
- `SF_SCRATCH_POOL_LEASE_TTL_SECONDS=5400`
- `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS=600`
- `SF_SCRATCH_POOL_HEARTBEAT_SECONDS=60`
- `SF_SCRATCH_POOL_MIN_REMAINING_MINUTES=120`
- `SF_SCRATCH_POOL_SEED_VERSION=alv-e2e-baseline-v1`
- `SF_SCRATCH_POOL_SNAPSHOT_NAME=<snapshot>`

Example:

```bash
SF_SCRATCH_STRATEGY=pool SF_SCRATCH_POOL_NAME=alv-e2e PLAYWRIGHT_WORKERS=7 npm run test:e2e
```

If `SF_SCRATCH_STRATEGY` is unset, the helper automatically switches to pool mode when `SF_SCRATCH_POOL_NAME` is present. The legacy single-scratch flow still works and remains the fallback when the pool is not configured.

## GitHub Actions

The Playwright workflow supports two modes:

- Pool mode when `SF_SCRATCH_POOL_NAME` and `SF_DEVHUB_AUTH_URL` are configured
- Legacy single-scratch fallback when pool configuration is missing

Repository secrets for pool mode:

- `SF_DEVHUB_AUTH_URL`

Repository variables for pool mode:

- `SF_SCRATCH_POOL_NAME`
- `SF_SCRATCH_POOL_LEASE_TTL_SECONDS` (optional)
- `SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS` (optional)
- `SF_SCRATCH_POOL_HEARTBEAT_SECONDS` (optional)
- `SF_SCRATCH_POOL_MIN_REMAINING_MINUTES` (optional)
- `SF_SCRATCH_POOL_SEED_VERSION` (optional)
- `SF_SCRATCH_POOL_SNAPSHOT_NAME` (optional)

When pool mode is active, the workflow lets each Playwright worker acquire its own scratch org slot and reuse the stored `sfdxAuthUrl` for future runs. The repository workflow defaults to `7` Playwright workers so the current seven E2E specs can run in parallel on CI.

## Codex Cloud

Codex Cloud can use the same pool model.

- Keep `SF_DEVHUB_AUTH_URL` as a setup-only secret
- Materialize that secret into an env var or temp file during setup
- Let the task runtime use the Dev Hub auth URL to create or recreate slots
- Let the pool API return the slot-specific `sfdxAuthUrl` when the scratch is reused

This keeps local, CI, and Codex Cloud on the same non-JWT scratch-org reuse model.
