---
name: verify-capture-lease
description: Use when a change touches the Custom Logs capture lease (`tryAcquireLease`, `reclaimDeadLease`, `judgeLease`, `Lease.stillHeld`/`release` in packages/core/src/localStore/workspaceFs.ts, `openWriter`/`advance`/`release` in events/store.ts, or `acquire`/`epoch` in events/capture.ts). Model-checks with TLA+ that at most one process captures an event object and replays the model on the real code. One command, about two minutes.
metadata:
  # Repo-only tooling: keeps `npx skills add electivus/apex-log-viewer` from publishing it with the skills/ catalog.
  internal: true
---

# Verify the capture lease

**Rule.** At most one process captures an event object at a time, and core never takes `capture.lease` from a process that is still alive.

**Harm when it breaks.** Two VS Code windows or `sf electivus custom-log capture` runs subscribe to the same platform event channel. Salesforce delivers each event to both, which counts twice against the org's `DailyDeliveredPlatformEvents` allowance (shared by every subscriber in the org), and the store gets duplicate lines.

The promise is in docs/CUSTOM_LOGS.md, "Standby and the capture lease". The check has three parts:

1. **Model check.** `model/CaptureLease.tla` describes the lease protocol, and TLC checks every order of every process's file-system calls within the bounds below.
2. **Conformance.** `scripts/replay.mjs` replays model behaviors on the real code. Each model process runs as a real Node process over `openEventStore(...).openWriter()`, and each lease `link`, `lstat`, `unlink` and `process.kill(pid, 0)` waits at a gate until the replay lets it run. After every step, the replay checks that each real process is stopped at the call where the model says it is, and that `capture.lease` and the reclaim markers on disk hold the tokens the model says.
3. **Mutants.** Five broken copies of the model, each one a plausible code mistake, must each break a rule. This proves that the rules can fail. The fifth restores bug F1 (below).

## Does my change touch the verified code?

Coverage record. The model and the replay describe these functions:

| File                                             | Functions                                                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/localStore/workspaceFs.ts`    | `tryAcquireLease`, `reclaimDeadLease`, `judgeLease`, `pidLiveness`, `readSmallFile`, `unlinkIfPresent`, `createIfAbsent`, `writeFileAtomic` (the `keepExisting` link path), `Lease.stillHeld`, `Lease.release`, the `LEASE_*` constants |
| `packages/core/src/customLogs/events/store.ts`   | `openWriter` (lease part), writer `advance` (the `stillHeld` fence), writer `release`, `LeaseLostError`                                                                                                                                 |
| `packages/core/src/customLogs/events/capture.ts` | `acquire` (standby retry), `epoch` (`LeaseLostError` → release → standby), `flushBatch` (`advance` call)                                                                                                                                |

**Sync commit: `a74da07fe7e3216ee45d4f1f6e08f3755b12fad6`.** At that commit the model was confirmed to describe the code above, including the F1 fix. To see what changed since:

```bash
git diff a74da07fe7e3216ee45d4f1f6e08f3755b12fad6 -- packages/core/src/localStore/workspaceFs.ts packages/core/src/customLogs/events/store.ts packages/core/src/customLogs/events/capture.ts
```

store.ts and capture.ts also change for reasons unrelated to the lease. Look only at the functions in the table. Move the sync commit forward only after `check.mjs` passes and you have read the changed functions against the action table below. A passing replay alone does not prove that the model is current: the random behaviors might not take a new branch.

## Run

From the repo root, after `pnpm install --frozen-lockfile`:

```bash
node .agents/skills/verify-capture-lease/scripts/check.mjs
```

The check needs Node 24 and Java 11 or later (`java` on `PATH`, or set `JAVA`). The first run downloads tla2tools 1.7.4 to `~/.cache/alv-formal/` and checks its SHA-256. Use `TLA2TOOLS_JAR` to point at a local copy. `--only model|conformance|mutants` runs one part, and `--traces N` changes the number of conformance traces per config. The check runs the TypeScript source through `tsx`, so it needs no build. Model checking uses every core; on fewer than 8 cores it takes longer than two minutes.

To replay one trace by hand:

```bash
node .agents/skills/verify-capture-lease/scripts/replay.mjs <tlc.out or trace file> [--keep]
```

## Read the result

The check exits 0 when every verdict matches `model/checks.json`. It prints a work directory under the system temp directory, with one folder per TLC run, each holding `tlc.out`.

Read every TLC result with **`/pstack:statechart`**. Each run folder holds the copy of the model that TLC checked and its config, `Run.cfg`. Run statechart on that module and config, and give it `model/view.mjs` as the view. A broken rule then shows as its shortest path in plain words ("window 2 sees the reclaimer dead and deletes the reclaim marker"). When every rule holds, statechart draws how the lease moves between processes. Clean.cfg and Leftovers.cfg have millions of states, more than the chart budget, so statechart writes no chart for them. To get a chart, use a smaller config, such as `Procs = {1, 2}`, `MaxTokens = 3`, `MaxCrashes = 0`, `Leftovers = TRUE`, `UserDeletes = FALSE`, which has 80 states.

| Output                                                                                                               | Meaning                                                                                        | What to do                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAIL Clean.cfg OneCapturer: breaks` (or Leftovers.cfg, or NoLiveTheft), then `real code follows the counterexample` | A finding: the real code takes the path that breaks the rule.                                  | Report it with the statechart path. Do not weaken the rule or the model to make it pass.                                                                       |
| `FAIL ...: breaks`, then `replay on the real code diverged: state N ...`, and no code change since the sync commit   | A modeling error: the model allows a step that the code does not take.                         | The divergence names the first step and the call where the real process stopped. Fix the action in `CaptureLease.tla` that maps to that call.                  |
| `traces do not replay on the real code` or `TLC path(s) do not replay`, after a code change                          | The code no longer does what the model says. The message names the first diverging step.       | If the change was intended, update the model (next section) and run again. If the change was not intended, the divergence is a bug that the change introduced. |
| `Mutant ... breaks no rule` or `no longer applies`                                                                   | The rules are too weak to catch that mistake, or the mutant's text has drifted from the model. | Update the mutant's `replace` text in `checks.json` to the model's current text. Never delete a mutant to get a pass.                                          |
| `never taken: <branch>`                                                                                              | No replay ran that branch of the model on the real code.                                       | Add a witness rule to `Witness.tla` (see `Chain.cfg` and `Fence.cfg`) or raise the trace count.                                                                |
| `TLC failed on ...`                                                                                                  | A syntax error or an evaluation error in the model.                                            | Read `tlc.out`.                                                                                                                                                |

## Update the model after an intended change

Each action in `CaptureLease.tla` is one awaited file-system call, or one `process.kill(pid, 0)`, in the code. Another process can act between any two of them. A change that adds, removes, merges or reorders such calls must make the same change to the actions, and to `GATES` and `BRANCHES` in `scripts/replay.mjs` when a program counter is added or removed. A change to how reclaim markers are named must change `Name` in the model and the marker name check in `replay.mjs`.

| Action                           | Code (workspaceFs.ts unless named)                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StartAttempt`                   | capture.ts `acquire` → store.ts `openWriter` → `tryAcquireLease` mints `owner.token` (each standby poll mints a new one)                                                         |
| `CreateLease`                    | `createIfAbsent(leasePath, serialized)`: the `fs.link` in `writeFileAtomic`                                                                                                      |
| `ReadLease`                      | `readSmallFile(leasePath)` in `tryAcquireLease`; `undefined` → `continue`                                                                                                        |
| `JudgeHolder`                    | `judgeLease(holder, here)` → `pidLiveness` (`process.kill(pid, 0)`); `held` → `{ heldBy }` → standby; `reclaim` → `reclaimDeadLease` on `firstMarker`                            |
| `CreateMarker`                   | `createIfAbsent(marker, electorRecord)` in `reclaimDeadLease`                                                                                                                    |
| `ElectedReadLease`               | `(await readSmallFile(leasePath)) === deadRecord`                                                                                                                                |
| `ElectedUnlinkLease`             | `unlinkIfPresent(leasePath)` after that check                                                                                                                                    |
| `UnlinkPassedMarker`             | `for (const settled of passedOver) await unlinkIfPresent(settled)`, one step per marker                                                                                          |
| `UnlinkOwnMarker`                | `unlinkIfPresent(marker); return 'retry'` after the election                                                                                                                     |
| `ReadMarker`                     | `readSmallFile(marker)`; `undefined` → `'retry'`                                                                                                                                 |
| `JudgeElector`                   | `judgeLease(elector, here)`; alive (or unreadable) → `break` to the wait; dead → `passedOver.push(marker)`, `marker = ${firstMarker}-${elector.token}`, next loop turn           |
| `WaitSeesChange`, `WaitTimesOut` | the `while ((await readSmallFile(leasePath)) === deadRecord)` loop; `LEASE_RECLAIM_SETTLE_MS` is abstracted, so a wait can time out at any read that still finds the dead record |
| `FenceSeesLoss`                  | store.ts `advance` → `lease.stillHeld()` false → `LeaseLostError` → capture.ts `epoch` → `writer.release()` → standby                                                            |
| `Finish`                         | capture.ts `epoch` → `writer.release()` at the end of a run                                                                                                                      |
| `ReleaseRead`, `ReleaseUnlink`   | `Lease.release`: `(await tokenOnDisk()) === owner.token` then `unlinkIfPresent(leasePath)`                                                                                       |
| `Crash`                          | the process dies anywhere (window closed, SIGKILL, SIGTERM on `--follow`); its files stay                                                                                        |
| `UserDeletesLease`               | the user deletes `capture.lease` by hand, as docs/CUSTOM_LOGS.md tells them to when its holder is gone (only `Fence.cfg` enables it)                                             |

`model/checks.json` holds the expected verdict of every rule per config, the conformance seeds and the mutants. A rule that held before an intended change and breaks after it is a finding. Fixing the model to hide it is not allowed.

## Findings

**F1 (fixed in `a74da07f`): two live processes could both take the lease when the previous holder and a reclaimer of its lease had both died.** The fifth mutant in `checks.json` restores the old step, and `check.mjs` must report it caught on `Leftovers.cfg`.

Start: `capture.lease` names a dead process D. `capture.lease.reclaim-<D's token>` names a process E, which died inside `reclaimDeadLease` between creating the marker and deleting it. `Reach.cfg` shows that two crashes from clean files lead here. In the old code, two windows, 1 and 2, start a capture:

1. Both windows find the lease taken, see D dead, fail to create the marker, read it, and see E dead.
2. Window 1 deletes the marker, retries, creates its own marker, and reads `capture.lease`. It still names D, so window 1 is about to delete it.
3. Window 2 now deletes the marker by name. That deletes window 1's live marker, not E's.
4. Window 2 retries, creates its own marker, and reads `capture.lease`. It still names D, so window 2 is about to delete it too.
5. Window 1 deletes `capture.lease`, creates its own and captures.
6. Window 2 deletes `capture.lease`, which now names window 1, creates its own and captures.

Cause: `unlinkIfPresent` removes whatever file has the name when it runs, so "read, compare, unlink" is not atomic, and the old dead-elector branch could delete a marker that a live elector had recreated after the read.

Fix: no process deletes a marker it did not create while the dead record can still be the lease. A contender that finds a dead elector's marker passes over it and runs the election again on `capture.lease.reclaim-<D's token>-<dead elector's token>`. That name is new, because an elector's token is in at most one marker of D. The elected process deletes the markers it passed over only after it has read or removed the lease, when D's record can no longer come back. The names stay short (two tokens) however many electors die. The fix holds only when every process on the workspace runs it: an extension or plugin built before it still deletes a dead elector's marker.

## Scope

- **Verified.** Clean.cfg covers 3 processes on clean files, at most 5 `tryAcquireLease` calls, and at most 1 crash at any step: every interleaving, 3,523,552 states, and both rules hold. Leftovers.cfg covers 3 processes starting on a dead holder's lease and a dead elector's marker, at most 3 more calls, and 1 more crash at any step: 4,945,312 states, and both rules hold. Once, outside the check, 3 processes with 4 more calls and 1 crash (47,011,702 states) also held. The conformance replays cover 80 random behaviors with 3 processes and larger bounds, every witness path, on the real `openWriter`, `advance` and `release`. Together they run all 30 branches of the model on the real code.
- **Assumptions.** All processes run on one host. `judgeLease` keeps a lease whose holder is on another host, so a reclaim never happens across hosts. A pid is not reused while its record is on disk. `fs.link` is an atomic create-if-absent, and each `lstat`/`readFile` pair of `readSmallFile` reads one instant, because lease files are only published whole. Lease records are well formed; an unreadable one throws `LeaseUnreadableError`, which is not modeled. An unreadable marker is treated as a live elector, as in the code, but not modeled. The hostname does not change. Every process runs the same version of the lease code.
- **Not covered.** Checkpoint contents, and the window between `stillHeld()` and the checkpoint write in `advance`. Liveness: whether a dead holder's lease or a dead elector's marker is eventually cleared. A user deleting `capture.lease` is checked only for the fence (`Fence.cfg`), not against the rules: a user who deletes a live holder's lease lets a second process capture until the holder's next flush, which is what the fence is for. Data files, gaps and the store invariants I1–I5 of store.ts. The capture loop itself: `leaseChild.mjs` stands in for capture.ts with its acquire, fence and release commands. Windows and Linux file-system semantics: the replay ran on macOS and runs on whatever OS runs it.

## Files

- `model/CaptureLease.tla`: the model. `Clean.cfg` and `Leftovers.cfg` are the checks. `CleanSim.cfg` and `LeftoversSim.cfg` are the conformance configs, with no rules and larger bounds.
- `model/Witness.tla`, with `Reach.cfg`, `Chain.cfg` and `Fence.cfg`: paths that must exist, replayed on the real code. Their expected verdict is a break.
- `model/checks.json`: expected verdicts, conformance seeds and mutants. A mutant may name its own `cfg`.
- `model/view.mjs`: the view for `/pstack:statechart`.
- `scripts/check.mjs`: the one command. `scripts/replay.mjs`: the trace parser and the replay driver. `scripts/leaseChild.mjs`: one model process over the real store code.
