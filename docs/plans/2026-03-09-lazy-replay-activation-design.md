# Lazy Replay Activation Design

## Goal

Remove the Apex Replay Debugger as a hard activation dependency so Apex Log Viewer can activate independently and only load Replay Debugger support when the user explicitly starts a replay action.

## Context

The extension currently declares `salesforce.salesforcedx-vscode-apex-replay-debugger` in `package.json#extensionDependencies`. VS Code can delay activation of this extension until that dependency is available and activated. That startup coupling is redundant because replay actions already route through `ensureReplayDebuggerAvailable()` in `src/utils/replayDebugger.ts`, which detects commands, attempts on-demand activation, and shows guidance when support is missing.

## Architecture

The extension activation path stays unchanged except for the manifest dependency removal. Replay Debugger remains optional runtime functionality:

- `package.json` no longer declares the Replay Debugger in `extensionDependencies`.
- Core activation continues to register views and commands without waiting for Replay Debugger.
- Replay entry points in `src/services/logService.ts` and `src/provider/SfLogTailViewProvider.ts` keep calling `ensureReplayDebuggerAvailable()` before executing replay commands.
- `src/utils/replayDebugger.ts` remains the single runtime gate for command detection, on-demand extension activation, and user-facing guidance.

## Approach Options

### Recommended: remove the hard dependency and keep replay lazy

This directly fixes the startup bottleneck and reuses the runtime flow already implemented in the codebase.

### Alternative: keep startup dependency and optimize internal activation

This does not solve the VS Code-level wait on the dependency extension, so it was rejected.

### Alternative: remove dependency and add broader install/telemetry UX work

Useful, but larger in scope than the activation fix and not required to resolve the immediate issue.

## Testing Strategy

- Add a manifest-focused test that fails if `package.json#extensionDependencies` still includes the Apex Replay Debugger.
- Update integration expectations so Replay Debugger support is treated as optional for base extension activation.
- Keep replay-specific tests focused on the click path and runtime availability checks.
- Refresh testing docs to describe Replay Debugger as an optional dependency for replay flows, not for extension activation.

## Risks

- Some tests or helpers may still assume Replay Debugger is always preinstalled.
- E2E or integration flows that explicitly validate replay should continue installing the Salesforce extensions they need.

## Mitigations

- Limit the manifest change to the Replay Debugger dependency only.
- Preserve the existing runtime guard in `ensureReplayDebuggerAvailable()`.
- Update docs and tests together so the repository consistently models replay as optional-at-startup.
