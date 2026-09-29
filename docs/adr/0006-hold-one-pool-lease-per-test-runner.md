---
status: accepted
---

# Hold one Pool Lease per test runner

Each sequential test runner (Playwright worker) holds one Pool Lease across its consecutive tests instead of taking one per test, and Slot Recovery (`.github/workflows/slot-recovery.yml`, #1159) replaces retired environments outside any Real Org E2E run. Taking a lease per test cost acquisition, scratch re-authentication and preparation for every test, about 2–4 minutes per Real Org E2E Lane. Most of that cost bought no isolation, because a Pool Lease never guaranteed a fresh org: slots are reused across runs, and because the allocator prefers the lowest-key free healthy slot, a sequential runner often got the same slot back anyway.

The trade-off is isolation between consecutive tests in one runner, which now share the environment's state. We keep the guarantee that matters: a Pool Lease is exclusive while in use, and an environment that a failure made suspect is never reused. The first test whose outcome differs from its expected outcome, a failed fixture teardown, or a failed lease health check ends the Pool Lease at once and retires the environment. The runner's next org request takes a new Pool Lease, and so does a retry after a flaky failure, which runs in a new runner. Expected failures and runtime skips keep the Pool Lease, and a test that never requests the org cannot retire the environment.

## Considered options

- **One Pool Lease per test** (the previous rule). This gave the strongest isolation between tests, but the per-test overhead dominated lane time.
- **Recreating retired environments inline.** Rejected in favour of Slot Recovery. Inline recreation added about 75 seconds or more to whichever later test landed on the retired slot. Out-of-band replacement keeps a Pool Lease, including the new one a retry takes, from waiting for scratch creation.

## Consequences

- Tests in one runner must tolerate state left by earlier tests in the same environment, as they already had to across runs.
- Lease TTL, heartbeat and acquire-timeout settings are unchanged. Heartbeats keep a long-held Pool Lease alive for the runner's whole lifetime.
- A Pool Lease that expires without being released, for example when a runner is killed, still returns its environment to circulation without retiring it. That gap predates this decision and is tracked in #1156; longer-held leases widen it slightly.
