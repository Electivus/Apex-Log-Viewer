---
name: verify
description: Drive the Electivus Apex Log Viewer the way a user does and capture proof. It opens the VS Code extension's Logs panel, Log Viewer, Tail and Debug Flags webviews in a real VS Code window, and runs the `sf electivus` CLI plugin, both against a real Salesforce scratch org leased from the Dev Hub pool. Use it to show that an extension, webview, core or CLI change works in the running product rather than only in unit tests, or to reproduce a reported UI bug.
---

# Verify the Apex Log Viewer against a real org

This skill drives one long-lived session. `start` builds the repo and leases a real scratch org through the configured Dev Hub (the same pool `pnpm run test:e2e` uses). It seeds one Apex log, opens a temporary SFDX workspace targeting that org, and launches VS Code `stable` with `--extensionDevelopmentPath=apps/vscode-extension`. A detached host process keeps all of that open. You then send it small **step modules** (`.mjs` files) that run Playwright against the VS Code window. Each run is recorded under one evidence directory, and `stop` returns the org to the pool without deleting that directory.

The host reuses the E2E harness in `test/e2e/utils/` for org leasing, seeding, workspaces, VS Code launch, the command palette and webview frames, so selectors that work in `test/e2e/specs/` also work here.

All commands run from the repo root:

```bash
V=".claude/skills/verify/scripts/verify.mjs"
```

## Surfaces

- **Primary: the VS Code extension.** It has four webviews: the Logs panel and the Tail panel (bottom panel tabs), plus the Log Viewer and Debug Flags editor tabs. The Logs and Tail surfaces can also open in the editor area. Drive them with steps.
- **Secondary: the `sf electivus` Salesforce CLI plugin** (`packages/sf-plugin`). Run it with `node $V sf -- <args>` inside the session workspace so it shares the org and the `apexlogs/` store with the extension.
- **Not covered:** VSIX packaging (`pnpm run test:smoke:vsix`), the Agent Skills catalog (`pnpm run test:sf-plugin:package`) and telemetry ingestion (`pnpm run test:e2e:telemetry`).

## Launch

```bash
node $V start                  # pnpm run build, lease org, seed 1 log, launch VS Code
node $V start --no-build       # reuse the current build (only when nothing changed since the last build)
node $V start --target-org X   # use an org already authenticated in sf; no lease, no seeding unless --seed
node $V start --trace          # also record a Playwright trace (evidence/trace.zip); slower
node $V start --idle-minutes 60
```

The session is ready when `start` prints a JSON block containing `"ready": true`, along with the org alias, username, pool slot, workspace path, seeded `marker`/`logId` and `evidenceDir`. The same state is in `output/verify/session/session.json` (`"phase": "ready"`). A warm start takes about 1 minute: roughly 25 s to lease, 2 s to seed and 10 to 40 s to start VS Code. The first run in a fresh container also downloads VS Code into `.vscode-test/`, which adds about 25 s. `start` waits up to 15 minutes. If the host dies first, `start` prints the tail of `host.out` and exits 1.

Org selection comes from the environment, the same as for `test:e2e`:

- Dev Hub JWT variables (`SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_LOGIN_URL`, plus `SF_DEVHUB_PRIVATE_KEY` or `SF_DEVHUB_PRIVATE_KEY_FILE`) or a local `SF_DEVHUB_ALIAS` select the Dev Hub.
- `SF_SCRATCH_POOL_NAME` (or `SF_SCRATCH_STRATEGY=pool`) leases a pool slot. Without it, the session uses the single scratch `SF_SCRATCH_ALIAS`.
- The lease owner shows as `verify:<hostname>` unless you set `SF_SCRATCH_POOL_OWNER`.
- `--target-org <alias>` skips the Dev Hub entirely and drives a real org you already authenticated. Treat that org as someone else's data. It is not seeded by default. Only mutate it (trace flags, log deletion, anonymous Apex) when the user asked for that.

## Doctor

```bash
node $V doctor     # read-only; exit 0 = session ready to drive, 1 = something failed, 2 = preflight ok but no session
```

Run it first whenever anything looks off. **Preflight** checks Node against `.nvmrc`, `sf` on PATH, `xvfb-run` when there is no `DISPLAY`, installed dependencies, build artifacts, and the Dev Hub/pool configuration (parsed with `scripts/devhub-auth.js`, no network). **Session** checks the following: phase is `ready`; the host pid is alive and was started from this checkout's bundle; the VS Code window and workbench are alive; the pool lease heartbeat is healthy; the build on disk matches the build that was loaded; `session.ts` has not changed since start; `sf org display` still authenticates the org. If a session check says "stop and start again", do exactly that, because the window is running stale code.

## Drive

```bash
node $V run <step> ['{"json":"args"}']   # step = name in steps/ or a path to any .mjs file
node $V shot <name>                      # full-window screenshot into the evidence dir
node $V sf -- log sync --json            # sf electivus ... in the session workspace; --target-org added
```

A step is an ES module whose default export receives the live session. Write ad-hoc steps in your scratchpad (any path works). They need no imports, because everything arrives in the argument:

```js
// my-step.mjs
export default async function ({ page, h, expect, session, args }) {
  await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Logs');
  const logs = await h.logsFrame();
  await logs.locator('input[type="search"]').first().fill(session.seeded.marker);
  await expect(logs.locator(`[data-log-id="${session.seeded.logId}"]`)).toBeVisible({ timeout: 180_000 });
  return { shot: await h.shot('logs-match', logs) }; // returned JSON is printed and recorded
}
```

Steps run one at a time. A thrown error (including a failed `expect`) returns `"ok": false` with the stack and an automatic `NNN-run-<seq>-failure.png`, and `run` exits 1. The host stays up, so you can fix the step and run it again. Step files are re-imported on every run. Changes to `session.ts` need a restart.

`h` (helpers):

| Helper                                                               | What it does                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `runCommandWhenAvailable(title)` / `runCommand(title)`               | Command palette by visible title, e.g. `Electivus Apex Logs: Tail Logs`            |
| `executeCommandId(id)`, `openView(name)`                             | Palette by command id / `View: Open View...`                                       |
| `logsFrame()`, `tailFrame()`, `viewerFrame()`, `debugFlagsFrame()`   | Wait for that webview's content frame (default 120 s)                              |
| `frameWith(selector, timeoutMs)`                                     | Any webview frame containing `selector`                                            |
| `openDebugFlagsFromLogs()`, `openDebugFlagsFromTail()`               | Click the panel's Debug Flags button, retrying swallowed clicks; returns the frame |
| `shot(name, frameOrLocator?)`                                        | PNG into evidence: whole window, a frame's body, or one element                    |
| `saveEvidence(name, data)`, `copyToEvidence(path)`                   | Persist JSON/text or copy a file (e.g. from `session.workspacePath`)               |
| `toasts()`                                                           | Visible VS Code notification texts                                                 |
| `dismissNotifications()`, `closeQuickInput()`, `closeAuxiliaryBar()` | Clear UI that intercepts clicks                                                    |
| `seedLog()`, `seedErrorLog()`, `clearOrgLogs('all'\|'mine')`         | Create real ApexLogs (anonymous Apex) or delete them in the session org            |
| `orgAuth()`, `tooling.*`                                             | Read org state behind the UI (`tooling.getUserDebugTraceFlag(auth, userId)`, ...)  |

`session` holds `{ org, workspacePath, evidenceDir, seeded, repoRoot }`, `page` is the VS Code window (Playwright `Page`) and `expect` is Playwright's `expect`.

Stable handles (prefer these over text and position), grouped by webview:

- **Logs panel:** `[data-testid="logs-open-debug-flags"]`, `logs-errors-only-switch`, `logs-error-badge`, `logs-reason-badge`, `[data-log-id="<07L…>"]`, rows `[role="row"][tabindex="0"]`, search hits `mark.match-highlight`, `button[aria-label="Apex Replay"]`.
- **Log Viewer:** `input[placeholder="Search entries…"]`, `button[aria-label="Next match"]` / `"Previous match"`, the counter `getByText(/^\d+\/\d+$/)`, search hits as plain `mark` (not `.match-highlight`).
- **Tail:** `tail-open-debug-flags`, `tail-debug-level`.
- **Debug Flags:** `debug-flags-user-search`, `debug-flags-user-row-<userId>`, `debug-flags-ttl`, `debug-flags-apply`, `debug-flags-remove`, `debug-flags-notice`, `debug-level-manager*`.

The full list is in `packages/webview/src` (`grep -rho 'data-testid="[^"]*"'`).

Canned steps in `steps/` (each one asserts the end state and returns its proof paths):

- `logs-open-viewer`: search the seeded log body, then open it in the Log Viewer; asserts the cached `.log` file in `apexlogs/`.
- `tail-live`: choose a debug level and Start, emit a new log, see it stream in, then Stop.
- `debug-flags-apply-remove`: from the Logs panel, apply a USER_DEBUG trace flag to the E2E user, read it back through Tooling, remove it, and read it back again.

Per-feature recipes, entry points and traps are in [features/README.md](features/README.md). Check every entry point the map lists for a feature, not only the convenient one.

## Evidence

Everything goes to `output/verify/evidence/<YYYYMMDD-HHMMSS>/` (gitignored), and the directory survives `stop`:

- `NNN-<name>.png`: screenshots in order, from `001-ready.png` (the window before any step) to `NNN-final-window.png` (taken at stop).
- `steps.jsonl`: one record per `run` with the step path (repo-relative, or absolute for steps outside the repo), args, `ok`, duration, returned result or error, and failure screenshot.
- `cli-<time>-sf-<cmd>.json`: the exact command (`node packages/sf-plugin/bin/run.js electivus …`), cwd, exit code, stdout and stderr of every `sf` call.
- `vscode-logs/`: VS Code logs copied at stop. The extension's trace-level output channel is at `vscode-logs/<timestamp>/window1/exthost/electivus.apex-log-viewer/Electivus Apex Log Viewer.log`.
- `workspace-files.json`: every file left in the session workspace at stop (`apexlogs/` store, `sync-state.json`), with sizes.
- `host.out`: host progress and E2E timing lines. `session.json`: final session state (org, slot, phase).

Proof standards:

- Exercise the real user path: palette commands, buttons and keyboard in the webview. Do not post webview messages or call extension internals.
- Capture the action and the resulting state, for example the search match and then the opened viewer, not only the last screen.
- Verify side effects through a second channel. For files, read `session.workspacePath` (`apexlogs/orgs/<user>/logs/...`, `apexlogs/.alv/sync-state.json`). For org writes, read them back with `tooling.*` or `node $V sf -- trace-flag status ...`. A green toast alone is not proof.
- The org is real; only the pool lease is test infrastructure. Do not mock Salesforce.
- Evidence contains org data (usernames, log bodies, instance URLs). Never commit it. Redact it before you paste it anywhere public.

## Cleanup

```bash
node $V stop            # close VS Code, copy logs, delete workspace + VS Code profile, release lease as healthy
node $V stop --retire   # same, but mark the pool slot needs_recreate (you broke the org's state)
node $V stop --keep     # keep the temp workspace and redacted VS Code profile for inspection
```

`host.out` ends with `lease release sent for <slot>`. A `[e2e] scratch-org pool release failed` warning above that line means the Dev Hub refused it. To read the slot state back, run `node scripts/scratch-pool-admin.js list --pool-key "$SF_SCRATCH_POOL_NAME" --json` (read-only), which shows the slot `available`.

`stop` asks the host to shut down gracefully. If the host does not exit within 3 minutes, `stop` kills only the host pid and VS Code pid recorded in `session.json`. Never use `pkill code`/`pkill node`: the user may have their own VS Code or Node processes. The host also stops itself after `--idle-minutes` (default 30) without requests, so a forgotten session does not hold a pool slot shared with CI. After `stop`, `ls output/verify/evidence/<stamp>` still lists the proof.

Stale state, where `session.json` exists but the host is dead, is cleared by the next `start` or `stop`. The orphaned pool lease expires by its TTL (`SF_SCRATCH_POOL_LEASE_TTL_SECONDS`, default 90 min). Nothing else needs cleaning.

## Isolation

You can run one session per checkout, because state lives in `output/verify/session/` and `start` refuses to start a second one while a host is alive. Each session gets its own pool slot, temporary workspace, VS Code profile and Xvfb display. For two sessions side by side, use separate git worktrees. Never attach to or drive a VS Code window the session did not start.

## Gotchas

- **Rebuild means restart.** The extension host loads `dist/extension.js` once. After `pnpm run build`, or any source change you want to test, run `stop` and then `start`. `doctor` flags a mismatch.
- **A click into a webview sometimes does nothing the first time.** This was seen with the Logs panel's Debug Flags button. Call `h.dismissNotifications()` and `h.closeQuickInput()` before clicking, assert the resulting state rather than the click, and use the `openDebugFlagsFrom*` helpers, which retry with keyboard and DOM clicks.
- **Panel webviews are short** (about 260 px tall in the 1440x900 window). Rows below the fold exist but do not appear in screenshots. Before taking a shot, run `h.runCommand('View: Toggle Maximized Panel')` or `Electivus Apex Logs: Open Logs in Editor Area` / `Open Tail in Editor Area`.
- **Several webviews coexist.** `viewerFrame()` returns the first Log Viewer. When you open a second log, scope assertions by the log id shown in the header.
- **UI strings are English** because VS Code runs with the `C.UTF-8` locale. Text selectors such as `Search entries…` and `Start`/`Stop` would change under a pt-BR display language.
- **Pool slots are shared with CI.** Keep sessions short and stop them when done. Use `--retire` only when the org itself is damaged, not when the feature failed.
- **Machines that rely on the private `~/.config/electivus/apex-log-viewer/e2e.sh` bootstrap** (`docs/E2E_ARCH_WSL.md`) are not wired up here. Export `SF_DEVHUB_ALIAS` or the JWT variables in the shell instead.
