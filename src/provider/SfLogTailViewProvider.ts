import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { localize } from '../utils/localize';
import {
  listOrgs,
  getOrgAuth,
  fetchApexLogs,
  fetchApexLogBody,
  listDebugLevels,
  getActiveUserDebugLevel,
  ensureUserTraceFlag,
  type OrgAuth
} from '../salesforce';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { SELECTED_ORG_KEY } from '../shared/constants';
import { logInfo, logWarn, logError, showOutput } from '../utils/logger';

export class SfLogTailViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sfLogTail';
  private view?: vscode.WebviewView;
  // Polling tail state
  private tailRunning = false;
  private tailTimer: NodeJS.Timeout | undefined;
  private tailHardStopTimer: NodeJS.Timeout | undefined;
  private seenLogIds = new Set<string>();
  private currentAuth: OrgAuth | undefined;
  private currentDebugLevel: string | undefined;
  private lastPollErrorAt = 0;
  private logIdToPath = new Map<string, string>();
  private disposed = false;
  private selectedOrg: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    try {
      const persisted = (this.context as any)?.globalState?.get?.(SELECTED_ORG_KEY) as string | undefined;
      if (persisted) {
        this.selectedOrg = persisted;
        logInfo('Tail: restored selected org from globalState:', this.selectedOrg || '(default)');
      }
    } catch {
      // ignore missing globalState in tests
    }
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

    this.context.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        this.stopTail();
        logInfo('Tail webview disposed; stopped tail.');
      })
    );

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      const t = (message as any)?.type;
      if (t) {
        logInfo('Tail: received message from webview:', t);
      }
      if (message?.type === 'ready') {
        await this.sendOrgs();
        await this.sendDebugLevels();
        this.post({ type: 'init', locale: vscode.env.language });
        this.post({ type: 'tailStatus', running: this.tailRunning });
        return;
      }
      if (message?.type === 'getOrgs') {
        await this.sendOrgs();
        await this.sendDebugLevels();
        return;
      }
      if (message?.type === 'selectOrg') {
        const target = typeof message.target === 'string' ? message.target.trim() : undefined;
        const next = target || undefined;
        this.setSelectedOrg(next);
        logInfo('Tail: selected org set to', next || '(none)');
        await this.sendOrgs();
        await this.sendDebugLevels();
        return;
      }
      if (message?.type === 'openLog' && (message as any).logId) {
        const id = (message as any).logId;
        logInfo('Tail: openLog requested for', id);
        await this.openLog(id);
        return;
      }
      if (message?.type === 'replay' && (message as any).logId) {
        const id = (message as any).logId;
        logInfo('Tail: replay requested for', id);
        await this.replayLog(id);
        return;
      }
      if (message?.type === 'tailStart') {
        await this.startTail(typeof message.debugLevel === 'string' ? message.debugLevel.trim() : undefined);
        return;
      }
      if (message?.type === 'tailStop') {
        this.stopTail();
        return;
      }
      if (message?.type === 'tailClear') {
        this.post({ type: 'tailReset' });
        return;
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tail.js'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} https:; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';`;
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        :root { color-scheme: light dark; }
        body { color: var(--vscode-foreground); background: transparent; }
        select {
          background-color: var(--vscode-dropdown-background, var(--vscode-input-background));
          color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
          border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border));
          outline-color: var(--vscode-focusBorder);
        }
        option {
          background-color: var(--vscode-dropdown-background, var(--vscode-input-background));
          color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
        }
        option:checked, option:hover {
          background-color: var(--vscode-list-activeSelectionBackground, var(--vscode-dropdown-background));
          color: var(--vscode-list-activeSelectionForeground, var(--vscode-dropdown-foreground));
        }
      </style>
      <title>Apex Log Tail</title>
      </head>
      <body>
      <div id="root"></div>
      <script src="${scriptUri}"></script>
      </body>
      </html>`;
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  public async sendOrgs(): Promise<void> {
    try {
      const orgs = await listOrgs();
      logInfo('Tail: sendOrgs ->', orgs.length, 'org(s)');
      const selected =
        this.selectedOrg || orgs.find(o => o.isDefaultUsername)?.username || orgs[0]?.username || undefined;
      this.post({ type: 'orgs', data: orgs, selected });
    } catch {
      logWarn('Tail: sendOrgs failed; posting empty list');
      this.post({ type: 'orgs', data: [], selected: this.selectedOrg });
    }
  }

  private setSelectedOrg(username?: string): void {
    this.selectedOrg = username;
    try {
      void (this.context as any)?.globalState?.update?.(SELECTED_ORG_KEY, username);
    } catch {
      // ignore missing globalState in tests
    }
  }

  private async sendDebugLevels(): Promise<void> {
    // Load auth; if this fails, surface empty list once
    let auth: OrgAuth;
    try {
      auth = await getOrgAuth(this.selectedOrg);
    } catch {
      logWarn('Tail: could not load auth for debug levels');
      this.post({ type: 'debugLevels', data: [] });
      return;
    }

    // Fetch levels and active selection independently so one failure
    // doesn't block the other and result in an empty combobox.
    let levels: string[] = [];
    try {
      levels = await listDebugLevels(auth);
    } catch {
      logWarn('Tail: listDebugLevels failed');
      levels = [];
    }

    let active: string | undefined = undefined;
    try {
      active = await getActiveUserDebugLevel(auth);
    } catch {
      logWarn('Tail: getActiveUserDebugLevel failed');
      active = undefined;
    }

    // Ensure the active value appears in the list if present
    const out = Array.isArray(levels) ? [...levels] : [];
    if (active && !out.includes(active)) {
      out.unshift(active);
    }
    this.post({ type: 'debugLevels', data: out, active });
  }

  private async startTail(debugLevel?: string): Promise<void> {
    if (this.tailRunning) {
      logInfo('Tail: start requested but already running.');
      return;
    }
    if (!debugLevel) {
      this.post({ type: 'error', message: 'Select a debug level' });
      logWarn('Tail: start aborted; no debug level selected.');
      return;
    }
    this.currentDebugLevel = debugLevel;
    try {
      // Acquire auth once and reuse; salesforce.ts will refresh on 401
      const auth = await getOrgAuth(this.selectedOrg);
      this.currentAuth = auth;
      logInfo('Tail: acquired auth for', auth.username || '(default)', 'at', auth.instanceUrl);

      // Ensure an active TraceFlag exists for the user; create if missing
      try {
        const created = await ensureUserTraceFlag(auth, debugLevel);
        if (created) {
          logInfo('Tail: TraceFlag created for user with level', debugLevel);
        } else {
          logInfo('Tail: TraceFlag already active or unchanged');
        }
      } catch {
        logWarn('Tail: ensure TraceFlag failed (continuing)');
      }

      // Prime seen set with recent logs so we don't spam old entries on start
      try {
        const recent = await fetchApexLogs(auth, 20, 0, debugLevel);
        logInfo('Tail: primed seen set with', recent.length, 'recent logs for level', debugLevel);
        for (const r of recent) {
          if (r && typeof r.Id === 'string') {
            this.seenLogIds.add(r.Id);
          }
        }
      } catch {
        logWarn('Tail: prime recent logs failed; proceeding with empty seen set');
      }

      this.tailRunning = true;
      this.post({ type: 'tailStatus', running: true });
      logInfo('Tail: started; polling…');
      // Hard stop after 30 minutes to avoid runaway sessions
      if (this.tailHardStopTimer) {
        clearTimeout(this.tailHardStopTimer);
      }
      this.tailHardStopTimer = setTimeout(() => {
        if (this.tailRunning && !this.disposed) {
          logInfo('Tail: auto-stopping after 30 minutes.');
          this.post({ type: 'error', message: 'Tail stopped after 30 minutes.' });
          this.stopTail();
        }
      }, 30 * 60 * 1000);
      // Kick off loop immediately
      void this.pollOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('Tail: start failed ->', msg);
      this.post({ type: 'error', message: msg });
      // Surface the output channel to help users see internal errors
      showOutput(true);
      this.post({ type: 'tailStatus', running: false });
      this.tailRunning = false;
    }
  }

  private stopTail(): void {
    this.tailRunning = false;
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
      this.tailTimer = undefined;
    }
    if (this.tailHardStopTimer) {
      clearTimeout(this.tailHardStopTimer);
      this.tailHardStopTimer = undefined;
    }
    this.post({ type: 'tailStatus', running: false });
    logInfo('Tail: stopped.');
  }

  private async pollOnce(): Promise<void> {
    if (!this.tailRunning || this.disposed) {
      return;
    }
    let nextDelay = 1500; // backoff dynamically on errors
    try {
      const auth = this.currentAuth ?? (await getOrgAuth(this.selectedOrg));
      this.currentAuth = auth;
      const logs = await fetchApexLogs(auth, 20, 0, this.currentDebugLevel);
      logInfo('Tail: polled logs ->', logs.length);
      // Process newest to oldest so output is chronological
      for (let i = logs.length - 1; i >= 0; i--) {
        const r = logs[i];
        const id = r?.Id as string | undefined;
        if (!id || this.seenLogIds.has(id)) {
          continue;
        }
        this.seenLogIds.add(id);
        logInfo('Tail: new log', id, r?.Operation, r?.Status, r?.LogLength);
        // Fetch body and emit lines
        try {
          const body = await fetchApexLogBody(auth, id);
          await this.emitLogWithHeader(auth, r, body);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn('Tail: fetch body failed for', id, '->', msg);
          this.post({ type: 'error', message: msg });
        }
      }
      // Trim seen set occasionally to avoid unbounded growth
      if (this.seenLogIds.size > 2000) {
        const toDelete = this.seenLogIds.size - 1500;
        let n = 0;
        for (const k of this.seenLogIds) {
          this.seenLogIds.delete(k);
          if (++n >= toDelete) {
            break;
          }
        }
      }
      this.lastPollErrorAt = 0;
      nextDelay = 1200;
    } catch (e) {
      // Surface error but avoid spamming UI every tick
      const now = Date.now();
      if (now - this.lastPollErrorAt > 5000) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn('Tail: poll error ->', msg);
        this.post({ type: 'error', message: msg });
        this.lastPollErrorAt = now;
      }
      nextDelay = 3000;
    } finally {
      if (this.tailRunning && !this.disposed) {
        this.tailTimer = setTimeout(() => void this.pollOnce(), nextDelay);
      }
    }
  }

  private async emitLogWithHeader(auth: OrgAuth, r: any, body: string): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }
    const lines: string[] = [];
    const id = r?.Id as string | undefined;
    const header = `=== ApexLog ${id ?? ''} | ${r?.StartTime ?? ''} | ${r?.Operation ?? ''} | ${r?.Status ?? ''} | ${r?.LogLength ?? ''}`;
    lines.push(header);
    // Optionally save to workspace apexlogs folder for replay/open
    try {
      const { filePath } = await this.getLogFilePathWithUsername(auth.username, id ?? String(Date.now()));
      await fs.writeFile(filePath, body, 'utf8');
      if (id) {
        this.logIdToPath.set(id, filePath);
      }
      lines.push(`Saved to ${filePath}`);
      logInfo('Tail: saved log', id, 'to', filePath);
      // Notify webview about new tailed log with quick actions
      if (id) {
        this.post({
          type: 'tailNewLog',
          logId: id,
          startTime: r?.StartTime,
          operation: r?.Operation,
          status: r?.Status,
          logLength: typeof r?.LogLength === 'number' ? r.LogLength : undefined,
          savedPath: filePath
        });
      }
    } catch {
      logWarn('Tail: failed to save log to workspace (best-effort).');
    }
    // Append body lines
    for (const l of String(body || '').split(/\r?\n/)) {
      if (l) {
        lines.push(l);
      }
    }
    this.post({ type: 'tailData', lines });
  }

  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0]!.uri.fsPath;
    }
    return undefined;
  }

  private async ensureApexLogsDir(): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      const tempDir = path.join(os.tmpdir(), 'apexlogs');
      await fs.mkdir(tempDir, { recursive: true });
      return tempDir;
    }
    const dir = path.join(workspaceRoot, 'apexlogs');
    await fs.mkdir(dir, { recursive: true });
    // Try to add to .gitignore (best-effort)
    try {
      const gitignorePath = path.join(workspaceRoot, '.gitignore');
      const stat = await fs.stat(gitignorePath).catch(() => undefined as any);
      if (stat && stat.isFile()) {
        const content = await fs.readFile(gitignorePath, 'utf8').catch(() => '');
        const lines = content.split(/\r?\n/).map(l => l.trim());
        const hasEntry = lines.some(
          l => l === 'apexlogs' || l === 'apexlogs/' || l === '/apexlogs' || l === '/apexlogs/'
        );
        if (!hasEntry) {
          await fs.appendFile(gitignorePath, (content.endsWith('\n') ? '' : '\n') + 'apexlogs/\n', 'utf8');
        }
      }
    } catch {
      // ignore
    }
    return dir;
  }

  private async getLogFilePathWithUsername(
    username: string | undefined,
    logId: string
  ): Promise<{ dir: string; filePath: string }> {
    const dir = await this.ensureApexLogsDir();
    const safeUser = (username || 'default').replace(/[^a-zA-Z0-9_.@-]+/g, '_');
    const filePath = path.join(dir, `${safeUser}_${logId}.log`);
    return { dir, filePath };
  }

  // Tail webview actions
  private async openLog(logId: string): Promise<void> {
    try {
      const filePath = await this.ensureLogSaved(logId);
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
      logInfo('Tail: opened log', logId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: openLog failed ->', msg);
      this.post({ type: 'error', message: msg });
    }
  }

  private async replayLog(logId: string): Promise<void> {
    try {
      const filePath = await this.ensureLogSaved(logId);
      const uri = vscode.Uri.file(filePath);
      try {
        await vscode.commands.executeCommand('sf.launch.replay.debugger.logfile', uri);
      } catch {
        await vscode.commands.executeCommand('sfdx.launch.replay.debugger.logfile', uri);
      }
      logInfo('Tail: replay requested for', logId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: replay failed ->', msg);
      this.post({ type: 'error', message: msg });
    }
  }

  private async ensureLogSaved(logId: string): Promise<string> {
    const existing = this.logIdToPath.get(logId);
    if (existing) {
      return existing;
    }
    const auth = this.currentAuth ?? (await getOrgAuth(this.selectedOrg));
    this.currentAuth = auth;
    const body = await fetchApexLogBody(auth, logId);
    const { filePath } = await this.getLogFilePathWithUsername(auth.username, logId);
    await fs.writeFile(filePath, body, 'utf8');
    this.logIdToPath.set(logId, filePath);
    logInfo('Tail: ensured log saved at', filePath);
    return filePath;
  }
}
