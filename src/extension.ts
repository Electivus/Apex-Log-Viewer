import * as vscode from 'vscode';
import { SfLogsViewProvider } from './provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from './provider/SfLogTailViewProvider';
import type { OrgItem } from './shared/types';
import * as path from 'path';
import { promises as fs } from 'fs';
import { setApiVersion, getApiVersion } from './salesforce/http';
import { logInfo, logWarn, logError, showOutput, setTraceEnabled, disposeLogger } from './utils/logger';
import { detectReplayDebuggerAvailable } from './utils/warmup';
import { localize } from './utils/localize';
import { ApexLogDiagramPanelManager } from './provider/ApexLogDiagramPanel';
import { ApexLogCallTreePanelManager } from './provider/ApexLogCallTreePanel';
import { activateTelemetry, safeSendEvent, safeSendException, disposeTelemetry } from './shared/telemetry';
import { CacheManager } from './utils/cacheManager';
import { getBooleanConfig, affectsConfiguration } from './utils/config';
import { getErrorMessage } from './utils/error';
import { listOrgs, getOrgAuth } from './salesforce/cli';

interface OrgQuickPick extends vscode.QuickPickItem {
  username: string;
}

export async function activate(context: vscode.ExtensionContext) {
  const activationStart = Date.now();
  // Init TTL cache (best-effort; no-op if unavailable)
  try {
    CacheManager.init(context.globalState);
    await CacheManager.clearExpired();
  } catch {}
  // Initialize telemetry (no-op if no key/conn configured)
  try {
    activateTelemetry(context);
  } catch {
    // ignore telemetry init errors
  }
  safeSendEvent('extension.activate', {
    vscodeVersion: vscode.version,
    platform: process.platform,
    hasWorkspace: String(!!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
  });
  // Avoid @salesforce/core attempting to spawn Pino transports that fail when bundled
  try {
    if (!process.env.SF_DISABLE_LOG_FILE) process.env.SF_DISABLE_LOG_FILE = 'true';
    if (!process.env.SFDX_DISABLE_LOG_FILE) process.env.SFDX_DISABLE_LOG_FILE = 'true';
  } catch (e) {
    const msg = getErrorMessage(e);
    logWarn('Failed to set disable log file env vars ->', msg);
  }
  logInfo('Activating Electivus Apex Log Viewer extension…');
  // Configure trace logging from settings
  try {
    const trace = getBooleanConfig('sfLogs.trace', false);
    setTraceEnabled(trace);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'sfLogs.trace')) {
          const next = getBooleanConfig('sfLogs.trace', false);
          setTraceEnabled(next);
        }
      })
    );
  } catch (e) {
    const msg = getErrorMessage(e);
    logWarn('Failed to configure trace logging ->', msg);
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
  } catch (e) {
    logWarn('Failed to detect Apex Replay Debugger availability ->', getErrorMessage(e));
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
      } catch (e) {
        logWarn('Could not parse sfdx-project.json for sourceApiVersion ->', getErrorMessage(e));
      }
    } catch (e) {
      logInfo('No sfdx-project.json found in first workspace folder ->', getErrorMessage(e));
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

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.refresh', () => {
      safeSendEvent('command.refresh');
      return provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.selectOrg', async () => {
      logInfo('Command sfLogs.selectOrg invoked. Listing orgs…');
      try {
        const orgs: OrgItem[] = await listOrgs(true);
        const items: OrgQuickPick[] = orgs.map(o => ({
          label: o.alias ?? o.username,
          description: o.isDefaultUsername ? localize('selectOrgDefault', 'Default') : undefined,
          detail: o.instanceUrl || undefined,
          username: o.username
        }));
        const picked = await vscode.window.showQuickPick<OrgQuickPick>(items, {
          placeHolder: localize('selectOrgPlaceholder', 'Select an authenticated org')
        });
        if (!picked) {
          logInfo('Select org cancelled.');
          safeSendEvent('command.selectOrg', { outcome: 'cancel' });
          return;
        }
        const username = picked.username;
        provider.setSelectedOrg(username);
        logInfo('Selected org:', username);
        const count = orgs.length;
        const bucket = count === 0 ? '0' : count === 1 ? '1' : count <= 5 ? '2-5' : count <= 10 ? '6-10' : '10+';
        const hasDefault = String(orgs.some(o => o.isDefaultUsername));
        safeSendEvent('command.selectOrg', { outcome: 'picked', orgs: bucket, hasDefault });
        await provider.sendOrgs();
        await provider.refresh();
      } catch (e) {
        const msg = getErrorMessage(e);
        logError('Failed listing orgs ->', msg);
        vscode.window.showErrorMessage(localize('selectOrgError', 'Electivus Apex Logs: Failed to list orgs'));
        // Do not send raw error messages to telemetry; use a coarse code instead
        safeSendException('command.selectOrg', { code: 'LIST_ORGS_FAILED' });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.tail', async () => {
      logInfo('Command sfLogs.tail invoked. Opening Tail view and starting…');
      safeSendEvent('command.tail');
      await provider.tailLogs();
    })
  );

  // Diagram panel command
  const diagramPanel = new ApexLogDiagramPanelManager(context);
  context.subscriptions.push(diagramPanel);
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.showDiagram', async () => {
      logInfo('Command sfLogs.showDiagram invoked.');
      safeSendEvent('command.showDiagram');
      await diagramPanel.showForActiveEditor();
    })
  );
  // No auto-overlay; the diagram opens via the editor title button/command.

  // Call Tree panel command
  const callTreePanel = new ApexLogCallTreePanelManager(context);
  context.subscriptions.push(callTreePanel);
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.showCallTree', async () => {
      logInfo('Command sfLogs.showCallTree invoked.');
      safeSendEvent('command.showCallTree');
      await callTreePanel.showForActiveEditor();
    })
  );

  // Convenience: command to show the output channel
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.showOutput', () => {
      safeSendEvent('command.showOutput');
      showOutput(true);
    })
  );

  // Reset CLI cache command
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.resetCliCache', async () => {
      try {
        await CacheManager.delete('cli');
        logInfo('CLI cache cleared.');
        vscode.window.showInformationMessage('Electivus Apex Logs: CLI cache cleared');
      } catch (e) {
        const msg = getErrorMessage(e);
        logWarn('Failed clearing CLI cache ->', msg);
        vscode.window.showErrorMessage('Electivus Apex Logs: Failed to clear CLI cache');
      }
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
            logWarn('Warm-up failed for', id, '->', getErrorMessage(e));
          }
        }
      }
    };
    // Defer to avoid impacting our own activation time
    setTimeout(() => void warmUp(), 0);
  } catch (e) {
    logWarn('Failed to warm up Apex Replay Debugger ->', getErrorMessage(e));
  }

  // Preload CLI caches (org list and default org auth) in background
  try {
    const enabled = getBooleanConfig('sfLogs.cliCache.enabled', true);
    // Heuristic: skip when running inside VS Code test harness to avoid interfering with unit tests
    const isVsCodeTestHost = /\.vscode-test\b/i.test(String((vscode.env as any)?.appRoot || ''));
    if (enabled && !isVsCodeTestHost) {
      setTimeout(async () => {
        try {
          logInfo('Preloading CLI caches (org list, default auth)…');
          const orgs = await listOrgs(false);
          const def = orgs.find(o => o.isDefaultUsername) || orgs[0];
          if (def) {
            try {
              await getOrgAuth(def.username);
            } catch {}
          } else {
            // If no orgs, attempt default auth anyway (may fill cache if CLI has default)
            try {
              await getOrgAuth(undefined);
            } catch {}
          }
          logInfo('Preloading CLI caches done.');
        } catch (e) {
          // Best-effort; ignore errors
          logWarn('Preloading CLI caches failed ->', getErrorMessage(e));
        }
      }, 0);
    }
  } catch (e) {
    logWarn('Failed to schedule CLI cache preload ->', getErrorMessage(e));
  }

  // Return exports for tests and programmatic use
  try {
    const activationMs = Date.now() - activationStart;
    safeSendEvent('extension.activate.duration', undefined, { activationMs });
  } catch {}
  return {
    getApiVersion
  };
}

export function deactivate() {
  disposeLogger();
  try {
    disposeTelemetry();
  } catch {
    // ignore
  }
}
