---
name: verify-apex-log-viewer
description: Drive the Electivus Apex Log Viewer the way a user does and capture proof. It opens the VS Code extension's Logs panel, Log Viewer, Tail, Debug Flags and Custom Logs webviews in a real VS Code window, and runs the `sf electivus` CLI plugin, both against a real Salesforce scratch org from the configured Dev Hub (a pool slot or the reused single scratch). Use it to show that an extension, webview, core or CLI change works in the running product rather than only in unit tests, or to reproduce a reported UI bug.
metadata:
  # Repo-only tooling: keeps `npx skills add electivus/apex-log-viewer` from publishing it with the skills/ catalog.
  internal: true
---

# Verify the Apex Log Viewer against a real org

This skill drives one long-lived session. `start` builds the repo and gets a real scratch org through the configured Dev Hub, the same way `pnpm run test:e2e` does: a pool slot, or the single scratch `ALV_E2E_Scratch`, reused until it expires. It seeds an `ALV_E2E` debug level, a 60-minute `DEVELOPER_LOG` trace flag at that level on the authenticated user and one Apex log. It opens a temporary SFDX workspace targeting that org, and launches VS Code `stable` with `--extensionDevelopmentPath=apps/vscode-extension`. A detached host process keeps all of that open. You then send it small **step modules** (`.mjs` files) that run Playwright against the VS Code window. Each run is recorded under one evidence directory, and `stop` releases a pool slot (or keeps the single scratch outside CI, unless `SF_TEST_KEEP_ORG` says otherwise) without deleting that directory.

The host reuses the E2E harness in `test/e2e/utils/` for org leasing, seeding, workspaces, VS Code launch, the command palette and webview frames, so selectors that work in `test/e2e/specs/` also work here.

All commands run from the repo root:

```bash
V=".agents/skills/verify-apex-log-viewer/scripts/verify.mjs"
```

## Surfaces

- **Primary: the VS Code extension.** It has six webviews: the Logs, Tail and Custom Logs panels (bottom panel tabs), plus the Log Viewer, Custom Log Viewer and Debug Flags editor tabs. The Logs, Tail and Custom Logs surfaces can also open in the editor area. Custom Logs is experimental and appears only after its setting is turned on (see Gotchas). Drive them with steps.
- **Secondary: the `sf electivus` Salesforce CLI plugin** (`packages/sf-plugin`). Run it with `node $V sf -- <args>` inside the session workspace so it shares the org and the `apexlogs/` store with the extension.
- **Not covered:** VSIX packaging (`pnpm run test:smoke:vsix`), the Agent Skills catalog (`pnpm run test:sf-plugin:package`) and telemetry ingestion (`pnpm run test:e2e:telemetry`).

## Launch

```bash
node $V start                  # pnpm run build, get the org, seed, launch VS Code
node $V start --no-build       # reuse the current build (only when nothing changed since the last build)
node $V start --target-org X   # use an org already authenticated in sf; no lease, no seeding unless --seed
node $V start --no-seed        # skip seeding on a harness scratch
node $V start --trace          # also record a Playwright trace (evidence/trace.zip); slower
node $V start --idle-minutes 60
```

The session is ready when `start` prints a JSON block containing `"ready": true`, along with the org (`alias`, `username`, `instanceUrl`, `strategy` of `pool`, `single` or `existing`), the workspace path, the seeded `marker`/`logId` and `evidenceDir`. The same state is in `output/verify/session/session.json` (`"phase": "ready"`), which also holds the VS Code profile's `userDataDir`. A warm start takes about 25 s to 1 minute. Creating the single scratch, or the first run in a fresh container, which downloads VS Code into `.vscode-test/`, adds more. `start` waits up to 15 minutes. If the host dies first, `start` prints the tail of `host.out` and exits 1. A host that has not reached ready after 15 minutes stops itself and releases its lease.

Org selection comes from the environment, the same as for `test:e2e`:

- Dev Hub JWT variables (`SF_DEVHUB_CLIENT_ID`, `SF_DEVHUB_USERNAME`, `SF_DEVHUB_LOGIN_URL`, plus `SF_DEVHUB_PRIVATE_KEY` or `SF_DEVHUB_PRIVATE_KEY_FILE`) or a local `SF_DEVHUB_ALIAS` select the Dev Hub. Any JWT variable takes precedence over the alias, an incomplete JWT set fails, and CI refuses the alias.
- `SF_SCRATCH_POOL_NAME` (or `SF_SCRATCH_STRATEGY=pool`) leases a pool slot. Without it, the session uses the single scratch `SF_SCRATCH_ALIAS` (default `ALV_E2E_Scratch`), created once and reused until it expires or is deleted.
- The lease owner shows as `verify:<hostname>` unless you set `SF_SCRATCH_POOL_OWNER`.
- `--target-org <alias>` skips the Dev Hub entirely and drives a real org you already authenticated. Treat that org as someone else's data. It is not seeded by default. Only mutate it (trace flags, log deletion, anonymous Apex) when the user asked for that.

## Doctor

```bash
node $V doctor     # read-only; exit 0 = session ready to drive, 1 = something failed, 2 = preflight ok but no session
```

Run it first whenever anything looks off. **Preflight** checks Node against `.nvmrc`, `sf` on PATH, `xvfb-run` on Linux (unless `ALV_E2E_SHOW_VSCODE=1` and a `DISPLAY` show the window), installed dependencies, build artifacts, and the Dev Hub/pool configuration (parsed with `scripts/devhub-auth.js`, no network). **Session** checks the following: phase is `ready`; the host pid is alive and was started from this checkout's bundle; the VS Code window and workbench are alive; the pool lease heartbeat is healthy; the build on disk matches the build that was loaded; `session.ts` has not changed since start; `sf org display` still authenticates the org. If a session check says "stop and start again", do exactly that, because the window is running stale code. Once a session exists, exit 0 no longer reflects preflight failures, so read the preflight lines too. `doctor` also resets the host's idle timer.

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

Steps run one at a time. Playwright actions without an explicit `timeout` fail after 60 s, so a missing element cannot hang the session, but each wait for an absent element costs those 60 s: probe optional elements with `locator.count()` first. A step cannot be cancelled once sent. A thrown error (including a failed `expect`) returns `"ok": false` with the stack and an automatic `NNN-run-<seq>-failure.png`, and `run` exits 1. The host stays up, so you can fix the step and run it again. The step file is re-imported on every run, but modules it imports (such as `steps/lib/events.mjs`) stay cached until a restart. Changes to `session.ts` need a restart.

`h` (helpers):

| Helper                                                               | What it does                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runCommandWhenAvailable(title, timeoutMs?)` / `runCommand(title)`   | Command palette by visible title, e.g. `Electivus Apex Logs: Tail Logs`; runs only the row labelled exactly `title` and fails if there is none                         |
| `openView(name)`                                                     | `View: Open View`, then the view or panel named exactly `name`                                                                                                         |
| `logsFrame()`, `tailFrame()`, `viewerFrame()`, `debugFlagsFrame()`   | Wait for that webview's content frame (default 120 s)                                                                                                                  |
| `customLogsFrame()`, `customLogViewerFrame(timeoutMs?, title?)`      | Custom Logs list (needs the setting on); transaction viewer, scoped by its title                                                                                       |
| `setWorkspaceSetting(key, value)`                                    | Edit the session workspace's `.vscode/settings.json`; `undefined` removes the key; applied live                                                                        |
| `frameWith(selector, timeoutMs)`                                     | Any webview frame containing `selector`                                                                                                                                |
| `openDebugFlagsFromLogs()`                                           | Close an open Apex Debug Flags tab, refresh Logs, click its Debug Flags button with keyboard and DOM retries; returns the frame the click opened                       |
| `openDebugFlagsFromTail()`                                           | Close an open Apex Debug Flags tab, check the org shown in Tail, click its Debug Flags button with retries, check the editor's org; returns the frame the click opened |
| `shot(name, frameOrLocator?)`                                        | PNG into evidence: whole window, a frame's body, or one element                                                                                                        |
| `saveEvidence(name, data)`, `copyToEvidence(path, name?)`            | Write `NNN-<name>.json` (or `.out` for a string) / copy a file to `NNN-<name>.copy`                                                                                    |
| `toasts()`                                                           | Visible VS Code notification texts                                                                                                                                     |
| `dismissNotifications()`, `closeQuickInput()`, `closeAuxiliaryBar()` | Clear UI that intercepts clicks                                                                                                                                        |
| `seedLog()`, `seedErrorLog()`, `clearOrgLogs('all'\|'mine')`         | Create real ApexLogs (anonymous Apex, renewing the seed flag) or delete them in the session org                                                                        |
| `orgAuth()`, `tooling.*`                                             | Org auth and the E2E Tooling helpers (`tooling.executeAnonymousApex(auth, apex)`, ...)                                                                                 |
| `sleep(ms)`                                                          | Wait, only where the product gives no signal to wait for                                                                                                               |

`tooling.getUserDebugTraceFlag`, `removeUserDebugTraceFlags` and the seeding helpers work on `DEVELOPER_LOG` flags only, despite their names. Both `openDebugFlagsFrom*` helpers close only the Apex Debug Flags tab, with a middle-click, and un-maximize the panel when it hides the editor area. `session` holds `{ org, workspacePath, evidenceDir, seeded, repoRoot }`, `page` is the VS Code window (Playwright `Page`), `app` is the Electron application and `expect` is Playwright's `expect`.

Stable handles (prefer these over text and position), grouped by webview:

- **Logs panel:** `[data-testid="logs-open-debug-flags"]`, `logs-errors-only-switch`, `logs-error-badge`, `logs-reason-badge`, `logs-status-text`, `[data-log-id="<07L…>"]`, rows `[role="row"][tabindex="0"]`, headers `[role="columnheader"][aria-sort]`, search hits `mark.match-highlight`, `button[aria-label="Open"]`, `button[aria-label="Apex Replay"]`.
- **Log Viewer:** `input[placeholder="Search entries…"]`, `button[aria-label="Next match"]` / `"Previous match"`, the counter `getByText(/^\d+\/\d+$/)`, the active match `.ring-1.ring-amber-400`, search hits as plain `mark` (not `.match-highlight`).
- **Tail:** `tail-open-debug-flags`, `tail-debug-level`, the org select `getByRole('combobox').first()`, `getByLabel('Search live logs…')`, switches `getByRole('switch', { name: 'Debug Only' | 'Color' | 'Auto-scroll' })`, rows `[role="row"]`.
- **Debug Flags:** `debug-flags-org-select`, `debug-flags-user-search`, `debug-flags-user-row-<userId>`, `debug-flags-special-target-*`, `debug-flags-target-unavailable`, `debug-flags-selected-target-label`, `debug-flags-log-type`, `debug-flags-other-log-type-note`, `debug-flags-other-log-type-switch`, `debug-flags-status-*` (`pill`, `level`, `expiration`, `resolved-count`, `active-count`), `debug-flags-ttl`, `debug-flags-apply`, `debug-flags-remove`, `debug-flags-notice`, `debug-flags-error`, `debug-level-*`.
- **Custom Logs:** `custom-logs-root`, `custom-logs-org`, `custom-logs-source`, `custom-logs-empty`, `custom-logs-capture` (its `data-state`), rows `[data-row-id="<recordId>"]`, `filter-chip`, `custom-log-row-detail`. **Custom Log Viewer:** `custom-log-viewer-root`, `custom-log-viewer-title`, `custom-log-apex-hint`, entries `[data-entry-id="<id>"]`, `custom-log-entry-detail`, `entry-field-<key>`, `payload-leaf-<path>`.

The full list is in `packages/webview/src`. Some ids are passed as a `testId` prop, so search both forms: `rg -o 'data-testid=[^ >]+|testId="[^"]+"' packages/webview/src`.

Canned steps in `steps/` (each one asserts the end state and returns its proof paths):

- `logs-open-viewer`: search the seeded log body, then open it in the Log Viewer; asserts the cached `.log` file in `apexlogs/`. `'{"query":"<text>","logId":"<07L…>"}'` opens another log.
- `tail-live`: require Tail to show the session org, turn Debug Only off, pick `ALV_E2E` (or `'{"debugLevel":"<name>"}'`, which fails if that level does not exist), clear and Start, write a log as soon as `Stop` appears, find it in the list, then Stop and, on every exit, put the user's `DEVELOPER_LOG` flags, Debug Only and the panel size back the way it found them.
- `debug-flags-apply-remove`: from the Logs panel, apply a trace flag of the default `DEVELOPER_LOG` type, at the level the panel preselects and a 45-minute TTL (`'{"ttlMinutes":N}'`), to the E2E user, read it back through Tooling, remove it, and read it back again. `'{"currentUser":true}'` targets the authenticated user instead, and that user's prior flag is restored afterwards.
- `custom-logs-setting`: write the experimental Custom Logs setting into the workspace settings (`'{"enabled":true}'`, `false`, or `null` to remove the key and get the default) and read back the view's Focus command in the Command Palette, the panel tab that command reveals and activates, the Custom Logs palette entries and any open Custom Logs editor tab.
- `events-capture`, `events-gap`: the Custom Logs panel on a platform event source of the dedicated `alv-events` scratch org (start the session with `--target-org alv-events`; on any other org they fail at once). `events-capture` writes the source into the workspace, takes the first-use choice (`'{"initial":"retained"}'` replays what the event retains), publishes `count` events (default 5) through `scripts/events-org.mjs` and asserts the rows, the `Live` strip and its tooltip. First use shows only in a workspace that never stored a position for the object, so run it once per `start`; a second run fails at once. `events-gap` starts a stopped capture, closes a gap an earlier run left open by publishing one event, then stops the capture, moves the stored position past the bus and starts it again. It requires a new `cursorRejected` gap in `gaps.*.ndjson` and one more line on the strip, and screenshots it. Both default to `'{"object":"ALV_Test_Replay__e"}'`, whose retained backlog is small; see [features/custom-logs.md](features/custom-logs.md#platform-event-sources).
- `custom-logs-open-viewer`: turn the Custom Logs setting on, open the Custom Logs list, then one record (`'{"title":"<name>"}'` or `"logId"`, after an optional `"source"` switch) in the transaction viewer, and with `'{"openApexLog":true}'` its linked Apex log. It needs a ready source: a standard-object mapping on the harness scratch, or Nebula Logger with `--target-org` (see [features/custom-logs.md](features/custom-logs.md)).

Controls in `steps/` check the harness itself. Rerun them after changing `session.ts` or `steps/lib/`:

- `debug-flags-from-tail-control`: intercepts every click on Tail's Debug Flags button and requires `h.openDebugFlagsFromTail()` to fail instead of returning the editor that was already open, then opens it normally. Takes about 100 s, because the helper exhausts its retries.
- `tail-flag-cleanup-control`: does to the session user's `DEVELOPER_LOG` flags what Tail's Start does (moves the seed to another level, adds a flag the user did not have), runs `tail-live`'s restore from `steps/lib/traceFlags.mjs`, and requires the flags to equal the snapshot, with the added flag deleted. A live Start creates a flag only for a user with none, which a harness scratch never has, because the seed flag cannot be retyped or moved to another user.
- `events-entries`: on an `alv-events` session, maps `ALV_Test_Log__e` with payload paths (`msg`, `level`, `traceId`) over `Payload__c` and `Stack_Trace__c`, publishes `count` events with `payloadEntries` JSON-array items each (`scripts/events-org.mjs publish --payload-entries`), and asserts one row per array item, the row id shape and suffixes, the titles, the metric item's JSON title and the `INFO` badge of the `Stack_Trace__c` item; run it once per `start`.
- `events-gap-control`: on an `alv-events` session after `events-gap`, runs `events-gap` with its Start button wrapped so that the step's cursor edit is undone before Salesforce sees it, and requires the step to fail for want of a gap of its own. Rerun it after changing `events-gap.mjs` too, which the host caches like `steps/lib/` because the control imports it. Takes about 2 minutes and publishes one event when a gap is open.

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

`host.out` ends with `lease release sent for <slot>`, or `no pool lease to release` for the single scratch and `--target-org` sessions. The single scratch is kept for the next session unless `CI` is set or `SF_TEST_KEEP_ORG` is false, in which case `stop` deletes it. A `[e2e] scratch-org pool release failed` warning above that line means the Dev Hub refused it. To read the slot state back, run `node scripts/scratch-pool-admin.js list --pool-key "$SF_SCRATCH_POOL_NAME" --json` (read-only), which shows the slot `available`.

`stop` asks the host to shut down gracefully. If the host does not exit within 3 minutes, `stop` kills only the host pid and VS Code pid recorded in `session.json`. Never use `pkill code`/`pkill node`: the user may have their own VS Code or Node processes. The host also stops itself after `--idle-minutes` (default 30) without requests, so a forgotten session does not hold a pool slot shared with CI. After `stop`, `ls output/verify/evidence/<stamp>` still lists the proof.

Stale state, where `session.json` exists but the host is dead, is cleared by the next `start` or `stop`. The orphaned pool lease expires by its TTL (`SF_SCRATCH_POOL_LEASE_TTL_SECONDS`, default 90 min). Nothing else needs cleaning.

## Isolation

You can run one session per checkout, because state lives in `output/verify/session/` and `start` refuses to start a second one while a host is alive. Each session gets its own pool slot, temporary workspace, VS Code profile and Xvfb display on Linux. The VS Code window stays hidden: on Linux it runs on that Xvfb display, and on macOS and Windows it is transparent and click-through. Set `ALV_E2E_SHOW_VSCODE=1` before `start` to watch it. For two sessions side by side, use separate git worktrees. Never attach to or drive a VS Code window the session did not start.

## Gotchas

- **Rebuild means restart.** The extension host loads `dist/extension.js` once. After `pnpm run build`, or any source change you want to test, run `stop` and then `start`. `doctor` flags a mismatch.
- **A click into a webview sometimes does nothing the first time.** This was seen with the Debug Flags buttons in the Logs and Tail toolbars. Call `h.dismissNotifications()` and `h.closeQuickInput()` before clicking, wait for loading overlays to go (`getByRole('status', { name: 'Loading…' })`; in Tail it is the only `status`, but Custom Logs and the Logs toolbar have other `status` elements), assert the resulting state rather than the click, and use the `openDebugFlagsFrom*` helpers, which retry with keyboard and DOM clicks.
- **Modal dialogs are in the page.** The profile sets `window.dialogStyle: custom`, so confirmations (Download all, Clear logs) render as `.monaco-dialog-box` on `page`. Click their buttons there. The native style would be unreachable from Playwright.
- **The extension's own log is readable live.** `session.json`'s `userDataDir` holds `logs/<stamp>/window1/exthost/electivus.apex-log-viewer/Electivus Apex Log Viewer.log` while the session runs. It traces every webview message and host step, for example `Tail: subscribed to /systemTopic/Logging`.
- **Panel webviews are short** (about 260 px tall in the 1440x900 window), and the Logs, Tail and Custom Logs lists are virtualized. Rows below the fold are not in the DOM and do not appear in screenshots. Before asserting rows or taking a shot, run `h.runCommand('View: Toggle Maximized Panel')` (check the frame height first, because the command toggles) or `Electivus Apex Logs: Open Logs in Editor Area` / `Open Tail in Editor Area`. A maximized panel hides editor tabs, so toggle it back before driving a viewer.
- **Several webviews coexist.** `viewerFrame()` returns the first Log Viewer. When you open a second log, scope assertions by the log id shown in the header.
- **UI strings are English** because VS Code runs with the `C.UTF-8` locale. Text selectors such as `Start`/`Stop` and `Filter logs` would change under a pt-BR display language; the Log Viewer's strings are hard-coded English.
- **Custom Logs is off by default.** It is experimental, so the panel tab, its commands and its host code exist only while `electivus.apexLogViewer.customLogs.enabled` is true. A session starts with it off. Turn it on with the `custom-logs-setting` step or `h.setWorkspaceSetting('electivus.apexLogViewer.customLogs.enabled', true)`; `h.customLogsFrame()` throws at once while the workspace setting is not on. `custom-logs-open-viewer` does it for you.
- **The eighth panel tab hides in a "..." menu.** With a side bar open, or with a panel whose toolbar is wide such as Output, the Custom Logs tab does not fit next to Problems, Output, Debug Console, Terminal, Ports, Logs and Tail. VS Code moves it into the "Additional Views" menu, which is a native menu on macOS that Playwright cannot click. Reveal the view with `Electivus Custom Logs: Focus on Electivus Custom Logs View` instead: the tab becomes active, and VS Code keeps the active tab in the visible strip. `custom-logs-setting` does this.
- **A harness scratch has no Nebula Logger.** Map a standard object it does have (the `Account` mapping in [features/custom-logs.md](features/custom-logs.md)) in the session workspace's `sfdx-project.json`, or start with `--target-org <alias>` on an org that has Nebula. That mode does not seed, so create no data in someone else's org.
- **Start can move the seed flag.** Tail's Start points the user's newest `DEVELOPER_LOG` flag, the one seeding made, at the chosen level for 30 minutes. After a Start at a level other than `ALV_E2E`, a later `h.seedLog()` fails with `FIELD_INTEGRITY_EXCEPTION`. Steps that press Start restore the flag afterwards, as `tail-live` does.
- **`sf` must be on the session's PATH.** `start` shells out to `sf org display`, and the host inherits your PATH. When `sf` lives under another Node version than `.nvmrc` selects, append its bin directory after `nvm use`, so the repo tooling keeps the pinned Node.
- **Pool slots are shared with CI.** Keep sessions short and stop them when done. Use `--retire` only when the org itself is damaged, not when the feature failed.
- **Machines that rely on the private `~/.config/electivus/apex-log-viewer/e2e.sh` bootstrap** (`docs/E2E_ARCH_WSL.md`) are not wired up here. Export `SF_DEVHUB_ALIAS` or the JWT variables in the shell instead.
