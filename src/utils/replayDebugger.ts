import * as vscode from 'vscode';
import { logWarn } from './logger';
import { localize } from './localize';
import { getErrorMessage } from './error';

const APEX_REPLAY_DEBUGGER_EXTENSION_ID = 'salesforce.salesforcedx-vscode-apex-replay-debugger';

/**
 * Ensure Apex Replay Debugger commands are available.
 * Returns true when available, otherwise surfaces a user-facing error and returns false.
 */
export async function ensureReplayDebuggerAvailable(): Promise<boolean> {
  if (await detectReplayDebuggerAvailable()) {
    return true;
  }

  const replayExt = vscode.extensions.getExtension(APEX_REPLAY_DEBUGGER_EXTENSION_ID);
  if (replayExt) {
    // The Replay Debugger extension only contributes "last logfile" command in package.json.
    // The `sf.launch.replay.debugger.logfile*` commands are registered at activation time,
    // so `getCommands(true)` can return a false negative until the extension is activated.
    try {
      await replayExt.activate();
    } catch (e) {
      logWarn('Failed to activate Apex Replay Debugger extension ->', getErrorMessage(e));
    }

    if (await detectReplayDebuggerAvailable()) {
      return true;
    }

    const msg = localize(
      'replayCommandsUnavailableMessage',
      `Apex Replay Debugger is installed (${APEX_REPLAY_DEBUGGER_EXTENSION_ID}), but its commands are unavailable. Ensure it is enabled in this VS Code environment (Local/WSL/SSH/Dev Containers), then reload the window and try again.`
    );
    void vscode.window.showErrorMessage(msg);
    return false;
  }

  // If users explicitly disabled/uninstalled the dependency extension, fail gracefully with guidance.
  const msg = localize(
    'replayMissingExtMessage',
    `Apex Replay Debugger is unavailable. Install the Apex Replay Debugger extension (${APEX_REPLAY_DEBUGGER_EXTENSION_ID}) or the Salesforce Extension Pack (salesforce.salesforcedx-vscode) and ensure it is enabled in this VS Code environment (Local/WSL/SSH/Dev Containers).`
  );
  void vscode.window.showErrorMessage(msg);
  return false;
}

/**
 * Detects whether Apex Replay Debugger commands are available, without any UI.
 */
export async function detectReplayDebuggerAvailable(): Promise<boolean> {
  try {
    const cmds = await vscode.commands.getCommands(true);
    return cmds.includes('sf.launch.replay.debugger.logfile') || cmds.includes('sfdx.launch.replay.debugger.logfile');
  } catch (e) {
    logWarn('Failed to check Replay Debugger commands ->', getErrorMessage(e));
    return false;
  }
}
