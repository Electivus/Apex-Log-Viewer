import * as vscode from 'vscode';
import { SfLogsViewProvider } from './provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from './provider/SfLogTailViewProvider';
import { listOrgs } from './salesforce';
import type { OrgItem } from './shared/types';
import * as path from 'path';
import { promises as fs } from 'fs';
import { setApiVersion, getApiVersion } from './salesforce';
import { logInfo, logWarn, logError, showOutput, setTraceEnabled } from './utils/logger';

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
        description: o.isDefaultUsername ? 'Default' : undefined,
        detail: o.instanceUrl || undefined,
        username: o.username
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select an authenticated org' });
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

  // Return exports for tests and programmatic use
  return {
    getApiVersion
  };
}

export function deactivate() {}
