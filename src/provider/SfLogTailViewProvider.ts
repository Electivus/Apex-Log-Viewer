import * as vscode from 'vscode';
import { localize } from '../utils/localize';
import { listOrgs, getOrgAuth } from '../salesforce/cli';
import { listDebugLevels, getActiveUserDebugLevel } from '../salesforce/traceflags';
import type { OrgAuth } from '../salesforce/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { logInfo, logWarn } from '../utils/logger';
import { safeSendEvent } from '../shared/telemetry';
import { warmUpReplayDebugger, ensureReplayDebuggerAvailable } from '../utils/warmup';
import { buildWebviewHtml } from '../utils/webviewHtml';
import { TailService } from '../utils/tailService';
import { pickSelectedOrg } from '../utils/orgs';
import { getNumberConfig, affectsConfiguration } from '../utils/config';
import { getErrorMessage } from '../utils/error';
import { LogViewerPanel } from '../panel/LogViewerPanel';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';

export class SfLogTailViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sfLogTail';
  private view?: vscode.WebviewView;
  private disposed = false;
  private selectedOrg: string | undefined;
  private tailService = new TailService(m => this.post(m));

  constructor(private readonly context: vscode.ExtensionContext) {
    this.tailService.setOrg(this.selectedOrg);

    // React to tail buffer size changes live
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'sfLogs.tailBufferSize')) {
          try {
            const size = this.getTailBufferSize();
            this.post({ type: 'tailConfig', tailBufferSize: size });
          } catch {
            // ignore
          }
        }
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    this.disposed = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    logInfo('Tail webview resolved.');
    // Fire-and-forget warm-up of Replay Debugger when the Tail view opens
    try {
      setTimeout(() => void warmUpReplayDebugger(), 0);
    } catch (e) {
      logWarn('Tail: warm-up of Apex Replay Debugger failed ->', getErrorMessage(e));
    }

    this.context.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        // Stop timers and clear caches, but keep TailService reusable when the view reopens
        this.tailService.stop();
        logInfo('Tail webview disposed; stopped tail.');
      })
    );

    // Track window activity to adapt polling cadence (requires VS Code 1.89+; @types 1.90)
    try {
      this.tailService.setWindowActive(vscode.window.state?.active ?? true);
      const d = vscode.window.onDidChangeWindowState(e => {
        this.tailService.setWindowActive(e.active);
        if (e.active && this.tailService.isRunning() && !this.disposed) {
          this.tailService.promptPoll();
        }
      });
      this.context.subscriptions.push(d);
    } catch (e) {
      logWarn('Tail: window state tracking failed ->', getErrorMessage(e));
    }

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      const t = (message as any)?.type;
      if (t) {
        logInfo('Tail: received message from webview:', t);
      }
      if (message?.type === 'ready') {
        // Show loading while bootstrapping orgs and debug levels
        this.post({ type: 'loading', value: true });
        await this.sendOrgs();
        await this.sendDebugLevels();
        this.post({ type: 'init', locale: vscode.env.language });
        // Send tail buffer size configuration
        this.post({ type: 'tailConfig', tailBufferSize: this.getTailBufferSize() });
        this.post({ type: 'tailStatus', running: this.tailService.isRunning() });
        this.post({ type: 'loading', value: false });
        return;
      }
      if (message?.type === 'selectOrg') {
        const target = typeof message.target === 'string' ? message.target.trim() : undefined;
        const next = target || undefined;
        const prev = this.selectedOrg;
        this.setSelectedOrg(next);
        this.tailService.setOrg(next);
        if (prev !== next) {
          this.tailService.stop();
        }
        logInfo('Tail: selected org set to', next || '(none)');
        this.post({ type: 'loading', value: true });
        try {
          await this.sendOrgs();
          await this.sendDebugLevels();
        } finally {
          this.post({ type: 'loading', value: false });
        }
        return;
      }
      if (message?.type === 'openLog' && (message as any).logId) {
        const id = (message as any).logId;
        logInfo('Tail: openLog requested for', id);
        await this.openLog(id);
        return;
      }
      if (message?.type === 'openDebugFlags') {
        logInfo('Tail: openDebugFlags requested');
        await DebugFlagsPanel.show({
          selectedOrg: this.selectedOrg,
          sourceView: 'tail'
        });
        return;
      }
      if (message?.type === 'replay' && (message as any).logId) {
        const id = (message as any).logId;
        logInfo('Tail: replay requested for', id);
        await this.replayLog(id);
        return;
      }
      if (message?.type === 'tailStart') {
        // Surface loading while ensuring TraceFlag and priming tail
        this.post({ type: 'loading', value: true });
        try {
          await this.tailService.start(typeof message.debugLevel === 'string' ? message.debugLevel.trim() : undefined);
        } finally {
          this.post({ type: 'loading', value: false });
        }
        return;
      }
      if (message?.type === 'tailStop') {
        this.tailService.stop();
        return;
      }
      if (message?.type === 'tailClear') {
        this.tailService.clearLogPaths();
        this.post({ type: 'tailReset' });
        return;
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml(
      webview,
      this.context.extensionUri,
      'tail.js',
      localize('salesforce.tail.view.name', 'Electivus Apex Logs Tail')
    );
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getTailBufferSize(): number {
    return getNumberConfig('sfLogs.tailBufferSize', 10000, 1000, Number.MAX_SAFE_INTEGER);
  }

  public async sendOrgs(): Promise<void> {
    const t0 = Date.now();
    try {
      const orgs = await listOrgs();
      logInfo('Tail: sendOrgs ->', orgs.length, 'org(s)');
      const selected = pickSelectedOrg(orgs, this.selectedOrg);
      this.post({ type: 'orgs', data: orgs, selected });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('orgs.list', { outcome: 'ok', view: 'tail' }, { durationMs, count: orgs.length });
      } catch {}
    } catch (e) {
      logWarn('Tail: sendOrgs failed ->', getErrorMessage(e));
      this.post({ type: 'orgs', data: [], selected: this.selectedOrg });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('orgs.list', { outcome: 'error', view: 'tail' }, { durationMs });
      } catch {}
    }
  }

  private setSelectedOrg(username?: string): void {
    this.selectedOrg = username;
  }

  private async sendDebugLevels(): Promise<void> {
    const t0 = Date.now();
    // Load auth; if this fails, surface empty list once
    let auth: OrgAuth;
    try {
      auth = await getOrgAuth(this.selectedOrg);
    } catch (e) {
      logWarn('Tail: could not load auth for debug levels ->', getErrorMessage(e));
      this.post({ type: 'debugLevels', data: [] });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('debugLevels.load', { outcome: 'error' }, { durationMs });
      } catch {}
      return;
    }

    // Fetch levels and active selection concurrently so one failure
    // doesn't block the other and result in an empty combobox.
    const [levels, active] = await Promise.all([
      listDebugLevels(auth).catch(() => {
        logWarn('Tail: listDebugLevels failed');
        return [] as string[];
      }),
      getActiveUserDebugLevel(auth).catch(() => {
        logWarn('Tail: getActiveUserDebugLevel failed');
        return undefined as string | undefined;
      })
    ]);

    // Ensure the active value appears in the list if present
    const out = Array.isArray(levels) ? [...levels] : [];
    if (active && !out.includes(active)) {
      out.unshift(active);
    }
    this.post({ type: 'debugLevels', data: out, active });
    try {
      const durationMs = Date.now() - t0;
      safeSendEvent('debugLevels.load', { outcome: 'ok' }, { durationMs, count: out.length });
    } catch {}
  }
  // Tail webview actions
  private async openLog(logId: string): Promise<void> {
    const t0 = Date.now();
    this.post({ type: 'loading', value: true });
    try {
      const filePath = await this.tailService.ensureLogSaved(logId);
      await LogViewerPanel.show({ logId, filePath });
      logInfo('Tail: opened log', logId);
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('log.open', { view: 'tail' }, { durationMs });
      } catch {}
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('Tail: openLog failed ->', msg);
      this.post({ type: 'error', message: msg });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('log.open', { view: 'tail', outcome: 'error' }, { durationMs });
      } catch {}
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async replayLog(logId: string): Promise<void> {
    const t0 = Date.now();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize('replayStarting', 'Starting Apex Replay Debugger…'),
          cancellable: true
        },
        async (_progress, ct) => {
          const controller = new AbortController();
          ct.onCancellationRequested(() => controller.abort());
          const ok = await ensureReplayDebuggerAvailable();
          if (!ok || ct.isCancellationRequested) {
            return;
          }
          const filePath = await this.tailService.ensureLogSaved(logId, controller.signal);
          if (ct.isCancellationRequested) {
            return;
          }
          const uri = vscode.Uri.file(filePath);
          try {
            await vscode.commands.executeCommand('sf.launch.replay.debugger.logfile', uri);
          } catch (e) {
            if (!controller.signal.aborted) {
              logWarn('Tail: sf.launch.replay.debugger.logfile failed ->', getErrorMessage(e));
              await vscode.commands.executeCommand('sfdx.launch.replay.debugger.logfile', uri);
            }
          }
        }
      );
      logInfo('Tail: replay requested for', logId);
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('logs.replay', { view: 'tail', outcome: 'ok' }, { durationMs });
      } catch {}
    } catch (e) {
      if (e instanceof Error && e.message === 'aborted') {
        // cancellation; no error message
      } else {
        const msg = getErrorMessage(e);
        logWarn('Tail: replay failed ->', msg);
        this.post({ type: 'error', message: msg });
        try {
          const durationMs = Date.now() - t0;
          safeSendEvent('logs.replay', { view: 'tail', outcome: 'error' }, { durationMs });
        } catch {}
      }
    }
  }
}
