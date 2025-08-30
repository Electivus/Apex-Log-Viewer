import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';
import { localize } from './localize';

/**
 * Warm up the Apex Replay Debugger by activating its extension(s).
 * Fire-and-forget usage is recommended; this function never throws.
 */
export async function warmUpReplayDebugger(): Promise<void> {
  try {
    const candidates = [
      'salesforce.salesforcedx-vscode-apex-replay-debugger',
      // Fallback: meta extension which may activate dependencies
      'salesforce.salesforcedx-vscode'
    ];
    for (const id of candidates) {
      const ext = vscode.extensions.getExtension(id);
      if (!ext) {
        continue;
      }
      try {
        await ext.activate();
        logInfo('Warmed up extension:', id);
        return;
      } catch (e) {
        logWarn('Warm-up failed for', id, '->', e instanceof Error ? e.message : String(e));
      }
    }
  } catch {
    // ignore – best effort only
  }
}

/**
 * Ensure Apex Replay Debugger commands are available. If not, prompt to install.
 * Returns true when available (either already installed or after prompting), false otherwise.
 */
export async function ensureReplayDebuggerAvailable(): Promise<boolean> {
  try {
    const cmds = await vscode.commands.getCommands(true);
    const hasReplay = cmds.includes('sf.launch.replay.debugger.logfile') || cmds.includes('sfdx.launch.replay.debugger.logfile');
    if (hasReplay) {
      return true;
    }
  } catch {}
  const openExt = localize('replayMissingExtOpen', 'Open Extensions');
  const msg = localize(
    'replayMissingExtMessage',
    'Salesforce Extension Pack (includes Apex Replay Debugger) is required to replay logs.'
  );
  const picked = await vscode.window.showWarningMessage(msg, openExt);
  if (picked === openExt) {
    try {
      await vscode.commands.executeCommand(
        'workbench.extensions.search',
        '@id:salesforce.salesforcedx-vscode'
      );
    } catch {}
  }
  return false;
}

/**
 * Detects whether Apex Replay Debugger commands are available, without any UI.
 */
export async function detectReplayDebuggerAvailable(): Promise<boolean> {
  try {
    const cmds = await vscode.commands.getCommands(true);
    return cmds.includes('sf.launch.replay.debugger.logfile') || cmds.includes('sfdx.launch.replay.debugger.logfile');
  } catch {
    return false;
  }
}
