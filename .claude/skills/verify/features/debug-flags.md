# Debug Flags

The Apex Debug Flags editor tab manages trace flags and debug levels in the selected org. A user picks a target (an active user, or a special target such as Automated Process or Platform Integration), a log type (`DEVELOPER_LOG` by default, or `USER_DEBUG`), a debug level and TTL, and then applies or removes the flag of that type. In the debug level manager below, the user can create, edit, preset and delete debug levels.

## Sub-features

- `flags-target-user` searches users with `Find user` (`debug-flags-user-search`) and selects a row (`debug-flags-user-row-<userId>`).
- `flags-target-special` selects `Automated Process` or `Platform Integration` (`debug-flags-special-target-*`). When the org lacks one, the panel shows `debug-flags-target-unavailable` and disables Apply and Remove.
- `flags-log-type` switches `Log type` (`debug-flags-log-type`) between `DEVELOPER_LOG` and `USER_DEBUG`. The two are independent TraceFlag records, so switching re-reads the status of the selected target for the new type.
- `flags-other-log-type` shows `debug-flags-other-log-type-note` inside `CURRENT STATUS` in two cases. With `USER_DEBUG` selected and an active `DEVELOPER_LOG` flag on the target, an amber note says that flag's debug level applies until it expires. With `DEVELOPER_LOG` selected, no active `DEVELOPER_LOG` flag and an active `USER_DEBUG` flag, a blue note names its expiration and `debug-flags-other-log-type-switch` switches `Log type` to `USER_DEBUG`. Special targets say "on N of M matched targets". No note appears in any other case, nor while the status loads.
- `flags-apply` sets a debug level and `TTL (minutes)` (`debug-flags-ttl`), then clicks `debug-flags-apply`. `debug-flags-notice` confirms, and `CURRENT STATUS` shows `Active`, the level, Starts and Expires.
- `flags-remove` clicks `debug-flags-remove`. The notice confirms and the status becomes inactive.
- `flags-level-manager` (`debug-level-manager`) creates a level with `debug-level-manager-new`, fills `debug-level-draft-*` and `debug-level-field-<category>`, then saves (`debug-level-save`), resets, applies a preset or deletes (`debug-level-delete` → `debug-level-delete-confirm`).

## How to get to it (user POV)

- Click the `Debug Flags` button in the Logs panel toolbar.
- Click the `Debug Flags` button in the Tail panel toolbar.

## Driving it with verify steps

Preconditions:

- Baseline from `README.md`.
- The E2E user `alv.debugflags.<orgId>@example.com` exists, or the step can create it. `h.tooling.ensureDebugFlagsTestUser(auth)` handles both, and falls back to the current user when the org has no spare license.

- **Apply and remove from Logs.** Run `node .claude/skills/verify/scripts/verify.mjs run debug-flags-apply-remove`. It returns `ok: true`, `appliedTraceFlag` (id, `debugLevelName`, start and expiration as read from Tooling), `removed: true` and two shots. The applied shot shows `Active` with the level and expiry.
- **Open from Tail.** `const flags = await h.openDebugFlagsFromTail()`. The same editor opens and shows `Apex Debug Flags`.
- **Special target.** Click `[data-testid="debug-flags-special-target-automated-process"]`. `debug-flags-selected-target-label` contains `Automated Process`. Apply and remove behave as for a user when the org resolves the target. Otherwise `debug-flags-target-unavailable` names it. For the full assertion, see `test/e2e/specs/debugFlagsPanel.shared.ts` → `assertSpecialTargetBehavior`.
- **Debug level manager.** Click `debug-level-manager-new`, fill `debug-level-draft-developer-name` (for example `ALV_VERIFY_<timestamp>`), `debug-level-draft-master-label` and `debug-level-draft-language` (`en_US`), select values in `debug-level-field-apexCode` and the other category fields, then click `debug-level-save`. Read it back with `h.tooling.getDebugLevelByDeveloperName(auth, name)`. Delete it afterwards with `debug-level-delete`, then `debug-level-delete-confirm`, and confirm Tooling no longer returns it.
- **Proof.** Pair each UI shot with the Tooling read. As a second channel, run `node .claude/skills/verify/scripts/verify.mjs sf -- trace-flag status --user-id <userId> --json`, adding `--log-type USER_DEBUG` when the panel used that type. Its `result.otherLogType` and `warnings` match the note the panel shows.

## Gotchas

- Use `h.openDebugFlagsFrom*()` rather than a raw click. In a verify run, a forced click on the Logs panel's `Debug Flags` button once did nothing.
- The notice confirms only the UI request. Always read the TraceFlag back through Tooling, because the status pill can lag.
- `h.tooling` reads and seeds `DEVELOPER_LOG` flags, the panel default. A `USER_DEBUG` flag applied from the panel is invisible to it; read that one with `sf -- trace-flag status --log-type USER_DEBUG`.
- The authenticated user already has the `ALV_E2E` flag from session seeding. `debug-flags-apply-remove` with `'{"currentUser":true}'`, which also covers the no-license fallback, snapshots that flag and restores it afterwards. Ad-hoc steps that touch the current user must do the same.
- Remove every trace flag and debug level the step created. Pool orgs are reused by CI, and `ALV_E2E` is the level the E2E suite expects.
- User search queries the org. A newly created user can take seconds to appear, see `h.tooling.waitForDebugFlagsUserSearchAvailability`.
