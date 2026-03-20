# New Window Launch Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared new-window handoff support so the extension can reopen the current workspace in a new VS Code window and restore Logs, Tail, Debug Flags, or a specific Log Viewer target there.

**Architecture:** Keep the feature in the extension host. Add a focused `NewWindowLaunchService` that persists one short-lived launch request in `ExtensionContext.globalState`, validates it on startup, restores shared org context, and dispatches to existing surface open paths. Reuse current provider and panel code wherever possible, adding only the minimal public APIs needed for restore-time context handoff.

**Tech Stack:** TypeScript, VS Code extension API, Mocha unit tests via `scripts/run-tests-cli.js`, manifest/NLS metadata in `package.json` and `package.nls.json`

---

## File Structure

**Create:**

- `src/services/NewWindowLaunchService.ts`
  Responsibility: Persist, validate, consume, and dispatch one pending new-window launch request.
- `src/shared/newWindowLaunch.ts`
  Responsibility: Centralize request types, workspace-target shapes, and launch constants such as TTL.
- `src/test/newWindowLaunchService.test.ts`
  Responsibility: Unit coverage for request storage, workspace matching, TTL handling, and dispatch order.
- `docs/superpowers/plans/2026-03-20-new-window-launch-support.md`
  Responsibility: This implementation plan.

**Modify:**

- `src/utils/workspace.ts`
  Responsibility: Add canonical workspace-target helpers and the reopen target helper used by commands.
- `src/provider/SfLogTailViewProvider.ts`
  Responsibility: Expose the minimal public restore API for selected-org handoff without synthesizing webview messages.
- `src/provider/SfLogsViewProvider.ts`
  Responsibility: Reuse existing public org setter and expose any small restore helpers needed by activation.
- `src/extension.ts`
  Responsibility: Register the new commands, persist new-window requests, and consume pending launch requests during activation.
- `src/test/extension.activation.gating.test.ts`
  Responsibility: Activation-time coverage for pending-request consumption and command wiring.
- `src/test/provider.logs.behavior.test.ts`
  Responsibility: Focused behavior tests for logs and tail restore helpers.
- `src/test/tailService.test.ts`
  Responsibility: Tail-provider-facing tests that prove selected-org restore works through the new public API.
- `src/test/packageManifest.test.ts`
  Responsibility: Manifest-level guardrails for newly contributed commands and menu hooks.
- `package.json`
  Responsibility: Contribute new commands and menu entries.
- `package.nls.json`
  Responsibility: Add localized titles for the new commands.

## Execution Notes

- Use @superpowers:test-driven-development for every behavior change.
- Use @superpowers:verification-before-completion before claiming the feature is done.
- Keep `LAUNCH_REQUEST_TTL_MS` explicit and shared from one source.
- Treat multi-root windows without `workspace.workspaceFile` as first-folder-only in v1, matching the approved spec.

### Task 1: Add the launch-request model and workspace helper tests first

**Files:**
- Create: `src/shared/newWindowLaunch.ts`
- Create: `src/services/NewWindowLaunchService.ts`
- Create: `src/test/newWindowLaunchService.test.ts`
- Modify: `src/utils/workspace.ts`

- [ ] **Step 1: Write the failing unit tests for workspace targets and request validation**

```ts
test('builds a workspace-file target when workspace.workspaceFile exists', () => {
  const target = getCurrentWorkspaceTarget(vscodeStub);
  assert.deepEqual(target, {
    type: 'workspaceFile',
    uri: 'untitled:workspace.code-workspace'
  });
});

test('consumes only a fresh request whose workspace target matches the current window', async () => {
  const handled: string[] = [];
  await service.consumePendingLaunch({
    currentWorkspaceTarget,
    restoreWindowContext: async () => handled.push('context'),
    openLogs: async () => handled.push('logs')
  });
  assert.deepEqual(handled, ['context', 'logs']);
});
```

- [ ] **Step 2: Run the new unit tests to verify they fail for the expected reason**

Run: `npm run pretest && VSCODE_TEST_GREP="NewWindowLaunchService|workspace target" node scripts/run-tests-cli.js --scope=unit`
Expected: FAIL with missing helper/service exports and unmatched launch-request behavior.

- [ ] **Step 3: Implement the shared model, TTL constant, and workspace helpers**

```ts
export const LAUNCH_REQUEST_TTL_MS = 60_000;

export type PendingLaunchRequest =
  | {
      version: 1;
      kind: 'logs' | 'tail' | 'debugFlags';
      workspaceTarget: WorkspaceTarget;
      selectedOrg?: string;
      sourceView?: 'logs' | 'tail';
      createdAt: number;
      nonce: string;
    }
  | {
      version: 1;
      kind: 'logViewer';
      workspaceTarget: WorkspaceTarget;
      selectedOrg?: string;
      sourceView?: 'logs' | 'tail';
      logId: string;
      filePath: string;
      createdAt: number;
      nonce: string;
    };

export function getCurrentWorkspaceTarget(): WorkspaceTarget | undefined {
  if (vscode.workspace.workspaceFile) {
    return { type: 'workspaceFile', uri: vscode.workspace.workspaceFile.toString() };
  }
  const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return firstFolder ? { type: 'folder', uri: firstFolder.toString() } : undefined;
}
```

- [ ] **Step 4: Implement minimal launch-service storage and dispatch logic**

```ts
const request = await context.globalState.get<PendingLaunchRequest>(PENDING_LAUNCH_KEY);
if (!request || request.version !== 1 || !isLaunchKind(request.kind)) {
  await context.globalState.update(PENDING_LAUNCH_KEY, undefined);
  return;
}

if (request.kind === 'logViewer' && (!request.logId || !request.filePath)) {
  await context.globalState.update(PENDING_LAUNCH_KEY, undefined);
  return;
}

if (isExpired(request) || !workspaceTargetsEqual(request.workspaceTarget, currentWorkspaceTarget)) {
  await context.globalState.update(PENDING_LAUNCH_KEY, undefined);
  return;
}

await context.globalState.update(PENDING_LAUNCH_KEY, undefined);
await handlers.restoreWindowContext({ selectedOrg: request.selectedOrg });
```

- [ ] **Step 5: Re-run the focused unit tests**

Run: `npm run pretest && VSCODE_TEST_GREP="NewWindowLaunchService|workspace target" node scripts/run-tests-cli.js --scope=unit`
Expected: PASS for the new launch-service and workspace-helper tests.

- [ ] **Step 6: Commit the model and service foundation**

```bash
git add src/shared/newWindowLaunch.ts src/services/NewWindowLaunchService.ts src/utils/workspace.ts src/test/newWindowLaunchService.test.ts
git commit -m "feat(window): add launch request service"
```

### Task 2: Add the restore-time provider APIs needed by activation

**Files:**
- Modify: `src/provider/SfLogTailViewProvider.ts`
- Modify: `src/provider/SfLogsViewProvider.ts`
- Modify: `src/test/provider.logs.behavior.test.ts`
- Modify: `src/test/tailService.test.ts`

- [ ] **Step 1: Write the failing tests for tail selected-org restore and logs-provider reuse**

```ts
test('restoreSelectedOrg updates the tail provider without webview messages', async () => {
  await provider.restoreSelectedOrg('tail-user@example.com');
  assert.equal((provider as any).selectedOrg, 'tail-user@example.com');
});

test('tail restore opens the view but does not start tailing automatically', async () => {
  await restoreHandlers.openTail({ selectedOrg: 'tail-user@example.com' });
  assert.deepEqual(executed, [
    'workbench.view.extension.salesforceTailPanel',
    'workbench.viewsService.openView'
  ]);
});
```

- [ ] **Step 2: Run the targeted provider tests to verify they fail**

Run: `npm run pretest && VSCODE_TEST_GREP="SfLogsViewProvider behavior|openDebugFlags opens debug flags panel from tail view|restoreSelectedOrg" node scripts/run-tests-cli.js --scope=unit`
Expected: FAIL because `SfLogTailViewProvider` does not yet expose a public restore API and the restore path is not wired.

- [ ] **Step 3: Add the minimal public restore API to the tail provider**

```ts
public async restoreSelectedOrg(username?: string): Promise<void> {
  this.setSelectedOrg(username);
  this.tailService.setOrg(username);
  if (this.view) {
    await this.sendOrgs();
    await this.sendDebugLevels();
  }
}
```

- [ ] **Step 4: Add a small getter on the logs provider so command handlers can capture the current org explicitly**

```ts
public getSelectedOrg(): string | undefined {
  return this.orgManager.getSelectedOrg();
}

public setSelectedOrg(username?: string) {
  this.orgManager.setSelectedOrg(username);
}
```

- [ ] **Step 5: Re-run the focused provider tests**

Run: `npm run pretest && VSCODE_TEST_GREP="SfLogsViewProvider behavior|restoreSelectedOrg|openDebugFlags opens debug flags panel from tail view" node scripts/run-tests-cli.js --scope=unit`
Expected: PASS, with no test asserting an automatic `tailStart`.

- [ ] **Step 6: Commit the provider restore APIs**

```bash
git add src/provider/SfLogTailViewProvider.ts src/provider/SfLogsViewProvider.ts src/test/provider.logs.behavior.test.ts src/test/tailService.test.ts
git commit -m "feat(window): add restore APIs for logs surfaces"
```

### Task 3: Wire commands, startup consumption, and surface dispatch

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/panel/DebugFlagsPanel.ts`
- Modify: `src/test/extension.activation.gating.test.ts`

- [ ] **Step 1: Write the failing activation and command tests**

```ts
test('registers open-in-new-window commands', async () => {
  await extension.activate(createContext());
  assert.ok(commands.has('sfLogs.openLogsInNewWindow'));
  assert.ok(commands.has('sfLogs.openTailInNewWindow'));
  assert.ok(commands.has('sfLogs.openDebugFlagsInNewWindow'));
  assert.ok(commands.has('sfLogs.openLogInViewerInNewWindow'));
});

test('consumes a pending logViewer request during activation', async () => {
  context.globalState.get = () => pendingLogViewerRequest;
  await extension.activate(context);
  assert.deepEqual(logViewerShows, [{ logId: '07L...', filePath }]);
});

test('shows a warning and does not persist a request when no workspace is open', async () => {
  await commands.get('sfLogs.openLogsInNewWindow')?.();
  assert.deepEqual(warningMessages, ['Electivus Apex Logs: Open a workspace folder before opening logs in a new window.']);
});

test('clears the pending request when vscode.openFolder fails', async () => {
  executeCommandStub.rejects(new Error('open failed'));
  await assert.rejects(commands.get('sfLogs.openLogsInNewWindow')?.(), /open failed/);
  assert.deepEqual(globalStateUpdates.at(-1), [PENDING_LAUNCH_KEY, undefined]);
});
```

- [ ] **Step 2: Run the activation-focused tests to verify they fail**

Run: `npm run pretest && VSCODE_TEST_GREP="extension activation gating" node scripts/run-tests-cli.js --scope=unit`
Expected: FAIL with missing commands and missing pending-launch consumption behavior.

- [ ] **Step 3: Register the new commands and persist launch requests before `vscode.openFolder`**

```ts
await launchService.launchInNewWindow({
  kind: 'logs',
  selectedOrg: provider.getSelectedOrg(),
  workspaceTarget: getCurrentWorkspaceTarget()
});
```

- [ ] **Step 4: Consume pending requests during activation and dispatch in the approved order**

```ts
await launchService.consumePendingLaunch({
  restoreWindowContext: async ({ selectedOrg }) => {
    provider.setSelectedOrg(selectedOrg);
    await tailProvider.restoreSelectedOrg(selectedOrg);
  },
  openLogs: async ({ selectedOrg }) => { /* reveal logs + refresh */ },
  openTail: async ({ selectedOrg }) => { /* reveal tail only */ },
  openDebugFlags: async ({ selectedOrg }) => DebugFlagsPanel.show({ selectedOrg }),
  openLogViewer: async ({ logId, filePath }) => {
    await fs.access(filePath);
    await LogViewerPanel.show({ logId, filePath });
  }
});
```

- [ ] **Step 5: Add request validation and missing-file handling for `logViewer`**

```ts
if (request.kind === 'logViewer' && (!request.logId || !request.filePath)) {
  await clearPendingLaunch();
  return;
}

try {
  await fs.access(request.filePath);
} catch {
  void vscode.window.showErrorMessage(`Failed to restore Apex log viewer: ${request.filePath} is no longer available.`);
  return;
}
```

- [ ] **Step 6: Re-run the activation-focused tests**

Run: `npm run pretest && VSCODE_TEST_GREP="extension activation gating" node scripts/run-tests-cli.js --scope=unit`
Expected: PASS for new command registration, no-workspace failures, `openFolder` cleanup, and pending-launch consumption scenarios.

- [ ] **Step 7: Commit the extension orchestration**

```bash
git add src/extension.ts src/panel/DebugFlagsPanel.ts src/test/extension.activation.gating.test.ts
git commit -m "feat(window): restore logs surfaces in new windows"
```

### Task 4: Add manifest, NLS, and menu coverage

**Files:**
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `src/test/packageManifest.test.ts`

- [ ] **Step 1: Write the failing manifest tests for command and menu contributions**

```ts
test('contributes open-in-new-window commands for each supported surface', async () => {
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openLogsInNewWindow'));
  assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openTailInNewWindow'));
  assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openDebugFlagsInNewWindow'));
  assert.ok(commands.some((entry: any) => entry.command === 'sfLogs.openLogInViewerInNewWindow'));
});

test('adds title-menu entry points for logs, tail, and apex log editors', async () => {
  const menus = manifest.contributes?.menus ?? {};
  assert.ok((menus['view/title'] ?? []).some((entry: any) => entry.command === 'sfLogs.openLogsInNewWindow'));
  assert.ok((menus['view/title'] ?? []).some((entry: any) => entry.command === 'sfLogs.openTailInNewWindow'));
  assert.ok((menus['editor/title'] ?? []).some((entry: any) => entry.command === 'sfLogs.openLogInViewerInNewWindow'));
});

test('declares localized titles for all four new-window commands', async () => {
  assert.equal(nls['command.openLogsInNewWindow.title'], 'Open Logs in New Window');
  assert.equal(nls['command.openTailInNewWindow.title'], 'Open Tail in New Window');
  assert.equal(nls['command.openDebugFlagsInNewWindow.title'], 'Open Debug Flags in New Window');
  assert.equal(nls['command.openLogInViewerInNewWindow.title'], 'Open Log Viewer in New Window');
});
```

- [ ] **Step 2: Run the manifest test to verify it fails**

Run: `npm run pretest && VSCODE_TEST_GREP="package manifest" node scripts/run-tests-cli.js --scope=unit`
Expected: FAIL because the new command IDs, titles, and menu contributions are not yet present.

- [ ] **Step 3: Add the command contributions, titles, and menu placements**

```json
{
  "command": "sfLogs.openLogsInNewWindow",
  "title": "%command.openLogsInNewWindow.title%",
  "category": "Electivus Apex Logs"
}
```

Include an `editor/title` contribution for the log-viewer command so Apex log files expose the new-window entry point next to the existing viewer action.

- [ ] **Step 4: Add the matching `package.nls.json` strings**

```json
"command.openLogsInNewWindow.title": "Open Logs in New Window",
"command.openTailInNewWindow.title": "Open Tail in New Window",
"command.openDebugFlagsInNewWindow.title": "Open Debug Flags in New Window",
"command.openLogInViewerInNewWindow.title": "Open Log Viewer in New Window"
```

- [ ] **Step 5: Re-run the manifest test**

Run: `npm run pretest && VSCODE_TEST_GREP="package manifest" node scripts/run-tests-cli.js --scope=unit`
Expected: PASS for the new command, title, and menu assertions.

- [ ] **Step 6: Commit the manifest layer**

```bash
git add package.json package.nls.json src/test/packageManifest.test.ts
git commit -m "feat(window): add new-window command contributions"
```

### Task 5: Run focused verification and the final unit sweep

**Files:**
- Modify: none unless verification exposes defects
- Test: `src/test/newWindowLaunchService.test.ts`
- Test: `src/test/extension.activation.gating.test.ts`
- Test: `src/test/provider.logs.behavior.test.ts`
- Test: `src/test/tailService.test.ts`
- Test: `src/test/packageManifest.test.ts`

- [ ] **Step 1: Run the focused new-window suite**

Run: `npm run pretest && VSCODE_TEST_GREP="NewWindowLaunchService|extension activation gating|SfLogsViewProvider behavior|package manifest|restoreSelectedOrg" node scripts/run-tests-cli.js --scope=unit`
Expected: PASS for the new-window service, activation, provider, tail, and manifest coverage.

- [ ] **Step 2: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS with existing webview, e2e-utils, scripts, and unit coverage still green.

- [ ] **Step 3: Run type-check and lint verification**

Run: `npm run compile`
Expected: PASS with no TypeScript or ESLint errors.

- [ ] **Step 4: Inspect the final diff before completion**

Run: `git diff --stat HEAD~4..HEAD`
Expected: The diff is limited to the launch service, workspace helpers, provider APIs, extension wiring, tests, and manifest/NLS updates.

- [ ] **Step 5: Commit any verification-driven fixes**

```bash
git add src/services/NewWindowLaunchService.ts src/shared/newWindowLaunch.ts src/utils/workspace.ts src/provider/SfLogTailViewProvider.ts src/provider/SfLogsViewProvider.ts src/extension.ts src/test/newWindowLaunchService.test.ts src/test/extension.activation.gating.test.ts src/test/provider.logs.behavior.test.ts src/test/tailService.test.ts src/test/packageManifest.test.ts package.json package.nls.json
git commit -m "fix(window): polish new-window restore flow"
```
