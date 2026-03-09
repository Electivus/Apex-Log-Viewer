# E2E Salesforce Support Minimization Design

## Goal

Stabilize the Playwright E2E suite by minimizing the Salesforce extensions installed into the isolated VS Code profile and by hardening interactions against intrusive notifications.

## Context

The current E2E fixture installs `salesforce.salesforcedx-vscode` plus `salesforce.salesforcedx-vscode-apex-replay-debugger` for every scenario. The Salesforce Extension Pack pulls in `salesforce.salesforcedx-einstein-gpt` (`Agentforce Vibes`), which surfaces welcome toasts and sidebar contributions that interfere with clicks in the bottom panel. The failing `debugFlagsFilter` and `debugFlagsPanel` traces show notification overlays intercepting the debug-flags toolbar button.

## Architecture

The E2E harness should install only the support extensions required by each scenario:

- The base E2E fixture launches VS Code without the Salesforce pack.
- Scenarios that need Replay Debugger explicitly request `salesforce.salesforcedx-vscode-apex-replay-debugger`.
- `test/e2e/utils/vscode.ts` stops promoting Salesforce-related ids to the full extension pack.
- A reusable helper dismisses visible VS Code notifications before sensitive UI interactions and after startup.

## Approach Options

### Recommended: per-scenario support extensions plus notification cleanup

This removes the primary source of test interference, keeps scenario requirements explicit, and still leaves room to add narrowly scoped dependencies when a specific spec needs them.

### Alternative: keep the pack and disable `salesforce.salesforcedx-einstein-gpt`

This reduces one source of noise, but still keeps a much heavier and more variable test environment than necessary.

### Alternative: keep the pack and only add click-force / retries

This treats symptoms, not the environment problem, and makes the suite harder to maintain.

## Testing Strategy

- Add or update fixture/helper coverage so support extensions are optional and scenario-driven.
- Run focused Playwright specs for replay and debug-flags flows.
- Run the full `npm run test:e2e` suite after the focused checks pass.

## Risks

- Replay Debugger may require transitive support extensions that were previously hidden by the pack install.
- Some scenarios may still be sensitive to unrelated VS Code notifications.

## Mitigations

- Let VS Code install Replay Debugger dependencies through the extension itself rather than the full pack.
- Keep the fixture API explicit so new dependencies are added locally to the spec that needs them.
- Add a best-effort notification dismissal helper to reduce residual UI flakiness.
