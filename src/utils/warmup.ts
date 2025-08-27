import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';

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
