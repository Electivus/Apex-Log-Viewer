import * as vscode from 'vscode';
import { logWarn } from './logger';
import { localize } from './localize';
import { getErrorMessage } from './error';

/**
 * Ensure Apex Replay Debugger commands are available.
 * Returns true when available, otherwise surfaces a user-facing error and returns false.
 */
export async function ensureReplayDebuggerAvailable(): Promise<boolean> {
  const hasReplay = await detectReplayDebuggerAvailable();
  if (hasReplay) {
    return true;
  }

  // This should be rare because the Salesforce Extension Pack is declared as an extensionDependency.
  // If users explicitly disabled/uninstalled it, fail gracefully with guidance.
  const msg = localize(
    'replayMissingExtMessage',
    'Apex Replay Debugger is unavailable. Ensure the Salesforce Extension Pack (salesforce.salesforcedx-vscode) is installed and enabled.'
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
