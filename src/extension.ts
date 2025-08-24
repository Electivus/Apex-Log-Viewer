import * as vscode from 'vscode';
import { SfLogsViewProvider } from './provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from './provider/SfLogTailViewProvider';
import { listOrgs } from './salesforce';
import type { OrgItem } from './shared/types';
import * as path from 'path';
import { promises as fs } from 'fs';
import { setApiVersion, getApiVersion } from './salesforce';

export async function activate(context: vscode.ExtensionContext) {
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
        }
      } catch {
        /* ignore parse errors */
      }
    } catch {
      /* ignore missing */
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
      const orgs: OrgItem[] = await listOrgs();
      const items: (vscode.QuickPickItem & { username?: string })[] = [
        { label: '$(target) Use Default Org', description: 'Uses the CLI default org' },
        ...orgs.map(o => ({
          label: o.alias ?? o.username,
          description: o.isDefaultUsername ? 'Default' : undefined,
          detail: o.instanceUrl || undefined,
          username: o.username
        }))
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select an authenticated org' });
      if (!picked) {
        return;
      }
      const isDefault = picked.label.startsWith('$(target)');
      if (isDefault) {
        provider.setSelectedOrg(undefined);
      } else {
        const username = (picked as any).username as string | undefined;
        provider.setSelectedOrg(username ?? picked.label.trim());
      }
      await provider.sendOrgs();
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.tail', async () => {
      await provider.tailLogs();
    })
  );

  // Removed legacy openTailPanel command to avoid focus changes

  // Return exports for tests and programmatic use
  return {
    getApiVersion
  };
}

export function deactivate() {}
