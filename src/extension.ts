import * as vscode from 'vscode';
import { SfLogsViewProvider } from './provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from './provider/SfLogTailViewProvider';
import { listOrgs } from './salesforce/cli';
import type { OrgItem } from './shared/types';
import * as path from 'path';
import { promises as fs } from 'fs';
import { setApiVersion, getApiVersion } from './salesforce/http';
import { logInfo, logWarn, logError, showOutput, setTraceEnabled, disposeLogger } from './utils/logger';
import { detectReplayDebuggerAvailable } from './utils/warmup';
import { localize } from './utils/localize';

export async function activate(context: vscode.ExtensionContext) {
  logInfo('Activating Apex Log Viewer extension…');
  // Configure trace logging from settings
  try {
    const cfg = vscode.workspace.getConfiguration();
    const trace = !!cfg.get<boolean>('sfLogs.trace');
    setTraceEnabled(trace);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sfLogs.trace')) {
          const next = !!vscode.workspace.getConfiguration().get<boolean>('sfLogs.trace');
          setTraceEnabled(next);
        }
      })
    );
  } catch {
    // ignore
  }
  // Soft advice: if Apex Replay Debugger (via Salesforce Extension Pack) is missing, log a tip in Output
  try {
    setTimeout(async () => {
      const hasReplay = await detectReplayDebuggerAvailable();
      if (!hasReplay) {
        logInfo(
          localize(
            'replayPackAdvice',
            'Tip: To use Apex Replay, install the Salesforce Extension Pack (salesforce.salesforcedx-vscode).'
          )
        );
      }
    }, 0);
  } catch {}
  // Try to read sourceApiVersion from sfdx-project.json (first workspace folder)
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const root = folders[0]!.uri.fsPath;
    const proj = path.join(root, 'sfdx-project.json');
    try {
      const txt = await fs.readFile(proj, 'utf8');
      try {
        const json = JSON.parse(txt);
        const v = (json && json.sourceApiVersion) as string | undefined;
        if (v) {
          setApiVersion(v);
          logInfo('Detected sourceApiVersion from sfdx-project.json:', v);
        }
      } catch {
        logWarn('Could not parse sfdx-project.json for sourceApiVersion.');
      }
    } catch {
      logInfo('No sfdx-project.json found in first workspace folder.');
    }
  }
  const provider = new SfLogsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SfLogsViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Register Tail view provider
  const tailProvider = new SfLogTailViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SfLogTailViewProvider.viewType, tailProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(vscode.commands.registerCommand('sfLogs.refresh', () => provider.refresh()));

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.selectOrg', async () => {
      logInfo('Command sfLogs.selectOrg invoked. Listing orgs…');
      const orgs: OrgItem[] = await listOrgs();
      const items: (vscode.QuickPickItem & { username: string })[] = orgs.map(o => ({
        label: o.alias ?? o.username,
        description: o.isDefaultUsername ? localize('selectOrgDefault', 'Default') : undefined,
        detail: o.instanceUrl || undefined,
        username: o.username
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: localize('selectOrgPlaceholder', 'Select an authenticated org')
      });
      if (!picked) {
        logInfo('Select org cancelled.');
        return;
      }
      const username = (picked as any).username as string;
      provider.setSelectedOrg(username);
      logInfo('Selected org:', username);
      await provider.sendOrgs();
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.tail', async () => {
      logInfo('Command sfLogs.tail invoked. Opening Tail view and starting…');
      await provider.tailLogs();
    })
  );

  // Convenience: command to show the output channel
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.showOutput', () => {
      showOutput(true);
    })
  );

  // Removed legacy openTailPanel command to avoid focus changes

  // Warm up Apex Replay Debugger in the background so the first
  // user-triggered replay opens faster. Fire-and-forget and ignore failures
  // (e.g., dependency not installed in this environment).
  try {
    const warmUp = async () => {
      const candidates = [
        'salesforce.salesforcedx-vscode-apex-replay-debugger',
        // Fallback: meta extension (may indirectly activate dependencies)
        'salesforce.salesforcedx-vscode'
      ];
      for (const id of candidates) {
        const ext = vscode.extensions.getExtension(id);
        if (ext) {
          try {
            await ext.activate();
            logInfo('Warmed up extension:', id);
            break;
          } catch (e) {
            logWarn('Warm-up failed for', id, '->', e instanceof Error ? e.message : String(e));
          }
        }
      }
    };
    // Defer to avoid impacting our own activation time
    setTimeout(() => void warmUp(), 0);
  } catch {}

  // Return exports for tests and programmatic use
  return {
    getApiVersion
  };
}

export function deactivate() {
  disposeLogger();
}
