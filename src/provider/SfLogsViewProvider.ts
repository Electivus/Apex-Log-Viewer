import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { localize } from '../utils/localize';
import { createLimiter, type Limiter } from '../utils/limiter';
import {
  getOrgAuth,
  fetchApexLogs,
  fetchApexLogBody,
  fetchApexLogHead,
  extractCodeUnitStartedFromLines,
  clearListCache,
  listOrgs
} from '../salesforce';
import type { ApexLogRow, OrgItem } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { SELECTED_ORG_KEY } from '../shared/constants';
import { logInfo, logWarn, logError } from '../utils/logger';

export class SfLogsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sfLogViewer';
  private view?: vscode.WebviewView;
  private pageLimit = 100;
  private currentOffset = 0;
  private selectedOrg: string | undefined;
  private headLimiter: Limiter;
  private headConcurrency: number = 5;
  private disposed = false;
  private refreshToken = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.headLimiter = createLimiter(this.headConcurrency);
    // Restore last selected org from persisted state
    try {
      const persisted = (this.context as any)?.globalState?.get?.(SELECTED_ORG_KEY) as string | undefined;
      if (persisted) {
        this.selectedOrg = persisted;
        logInfo('Logs: restored selected org from globalState:', this.selectedOrg || '(default)');
      }
    } catch {
      // ignore missing globalState in tests
    }
    // React to settings changes live (no manual refresh required)
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sfLogs.headConcurrency')) {
          const cfg = vscode.workspace.getConfiguration();
          const configuredConcurrency = cfg.get<number>('sfLogs.headConcurrency');
          const nextConc =
            configuredConcurrency && Number.isFinite(configuredConcurrency)
              ? Math.max(1, Math.min(20, Math.floor(configuredConcurrency)))
              : this.headConcurrency;
          if (nextConc !== this.headConcurrency) {
            this.headConcurrency = nextConc;
            this.headLimiter = createLimiter(this.headConcurrency);
          }
        }
      })
    );
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
      // Without a workspace, fallback to temp dir to avoid failure
      const tempDir = path.join(os.tmpdir(), 'apexlogs');
      await fs.mkdir(tempDir, { recursive: true });
      return tempDir;
    }
    const dir = path.join(workspaceRoot, 'apexlogs');
    await fs.mkdir(dir, { recursive: true });
    // Update .gitignore if it exists
    try {
      const gitignorePath = path.join(workspaceRoot, '.gitignore');
      const stat = await fs.stat(gitignorePath).catch(() => undefined);
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
      // Silent: do not block on .gitignore updates
    }
    return dir;
  }

  private async findExistingLogFile(logId: string): Promise<string | undefined> {
    const dir = await this.ensureApexLogsDir();
    try {
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      // Prefer username-prefixed files, but also consider legacy <logId>.log
      const preferred = entries.find(name => name.endsWith(`_${logId}.log`));
      if (preferred) {
        return path.join(dir, preferred);
      }
      const legacy = entries.find(name => name === `${logId}.log`);
      if (legacy) {
        return path.join(dir, legacy);
      }
    } catch {
      // ignore
    }
    return undefined;
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

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    this.disposed = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    logInfo('Logs webview resolved.');
    // Dispose handling: stop posting and bump token to invalidate in-flight work
    this.context.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        this.refreshToken++;
        this.headLimiter = createLimiter(this.headConcurrency);
        logInfo('Logs webview disposed.');
      })
    );

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      if (message?.type === 'ready') {
        logInfo('Logs: message ready');
        await this.sendOrgs();
        await this.refresh();
        return;
      }
      if (message?.type === 'refresh') {
        logInfo('Logs: message refresh');
        await this.refresh();
      } else if (message?.type === 'getOrgs') {
        logInfo('Logs: message getOrgs');
        await this.sendOrgs();
      } else if (message?.type === 'selectOrg') {
        const target = typeof message.target === 'string' ? message.target.trim() : undefined;
        const next = target || undefined;
        this.setSelectedOrg(next);
        logInfo('Logs: selected org set to', next || '(none)');
        await this.refresh();
      } else if (message?.type === 'openLog' && message.logId) {
        logInfo('Logs: openLog', message.logId);
        await this.openLog(message.logId);
      } else if (message?.type === 'replay' && message.logId) {
        logInfo('Logs: replay', message.logId);
        await this.debugLog(message.logId);
      } else if (message?.type === 'loadMore') {
        logInfo('Logs: loadMore');
        await this.loadMore();
      }
    });
  }

  public async refresh() {
    if (!this.view) {
      return;
    }
    const token = ++this.refreshToken;
    this.post({ type: 'loading', value: true });
    try {
      clearListCache();
      const cfg = vscode.workspace.getConfiguration();
      const configuredPageSize = cfg.get<number>('sfLogs.pageSize');
      if (configuredPageSize && Number.isFinite(configuredPageSize)) {
        this.pageLimit = Math.max(10, Math.min(200, Math.floor(configuredPageSize)));
      }
      const configuredConcurrency = cfg.get<number>('sfLogs.headConcurrency');
      const nextConc =
        configuredConcurrency && Number.isFinite(configuredConcurrency)
          ? Math.max(1, Math.min(20, Math.floor(configuredConcurrency)))
          : this.headConcurrency;
      if (nextConc !== this.headConcurrency) {
        this.headConcurrency = nextConc;
        this.headLimiter = createLimiter(this.headConcurrency);
      }
      const auth = await getOrgAuth(this.selectedOrg);
      this.currentOffset = 0;
      const logs: ApexLogRow[] = await fetchApexLogs(auth, this.pageLimit, this.currentOffset);
      logInfo('Logs: fetched', logs.length, 'rows (pageSize =', this.pageLimit, ')');
      this.currentOffset += logs.length;
      if (token !== this.refreshToken || this.disposed) {
        return;
      }
      this.post({ type: 'init', locale: vscode.env.language });
      this.post({ type: 'logs', data: logs, hasMore: logs.length === this.pageLimit });

      // Limited parallel fetch of log heads
      for (const log of logs) {
        void this.headLimiter(async () => {
          try {
            const headLines = await fetchApexLogHead(
              auth,
              log.Id,
              10,
              typeof log.LogLength === 'number' ? log.LogLength : undefined
            );
            const codeUnit = extractCodeUnitStartedFromLines(headLines);
            if (codeUnit && token === this.refreshToken && !this.disposed) {
              this.post({ type: 'logHead', logId: log.Id, codeUnitStarted: codeUnit });
            }
          } catch {
            // ignore individual log error
          }
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Logs: refresh failed ->', msg);
      this.post({ type: 'error', message: msg });
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async loadMore() {
    if (!this.view) {
      return;
    }
    const token = this.refreshToken;
    this.post({ type: 'loading', value: true });
    try {
      const auth = await getOrgAuth(this.selectedOrg);
      const logs: ApexLogRow[] = await fetchApexLogs(auth, this.pageLimit, this.currentOffset);
      logInfo('Logs: loadMore fetched', logs.length);
      this.currentOffset += logs.length;
      if (token !== this.refreshToken || this.disposed) {
        return;
      }
      this.post({ type: 'appendLogs', data: logs, hasMore: logs.length === this.pageLimit });

      for (const log of logs) {
        void this.headLimiter(async () => {
          try {
            const headLines = await fetchApexLogHead(
              auth,
              log.Id,
              10,
              typeof log.LogLength === 'number' ? log.LogLength : undefined
            );
            const codeUnit = extractCodeUnitStartedFromLines(headLines);
            if (codeUnit && token === this.refreshToken && !this.disposed) {
              this.post({ type: 'logHead', logId: log.Id, codeUnitStarted: codeUnit });
            }
          } catch {
            // ignore per-log error
          }
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Logs: loadMore failed ->', msg);
      this.post({ type: 'error', message: msg });
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async openLog(logId: string) {
    try {
      // Open directly if already present (works even without CLI)
      const existing = await this.findExistingLogFile(logId);
      let targetPath: string;
      if (existing) {
        targetPath = existing;
      } else {
        const auth = await getOrgAuth(this.selectedOrg);
        const { filePath } = await this.getLogFilePathWithUsername(auth.username, logId);
        const body = await fetchApexLogBody(auth, logId);
        await fs.writeFile(filePath, body, 'utf8');
        targetPath = filePath;
      }
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
      vscode.window.showErrorMessage(
        localize('openError', 'Failed to open log: ') + (e instanceof Error ? e.message : String(e))
      );
      logWarn('Logs: openLog failed ->', e instanceof Error ? e.message : String(e));
    }
  }

  private async debugLog(logId: string) {
    try {
      this.post({ type: 'loading', value: true });
      // Use existing file if present; otherwise fetch and save with username prefix
      let targetPath = await this.findExistingLogFile(logId);
      if (!targetPath) {
        const auth = await getOrgAuth(this.selectedOrg);
        const { filePath } = await this.getLogFilePathWithUsername(auth.username, logId);
        const body = await fetchApexLogBody(auth, logId);
        await fs.writeFile(filePath, body, 'utf8');
        targetPath = filePath;
      }
      const uri = vscode.Uri.file(targetPath);
      try {
        await vscode.commands.executeCommand('sf.launch.replay.debugger.logfile', uri);
      } catch {
        await vscode.commands.executeCommand('sfdx.launch.replay.debugger.logfile', uri);
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        localize('replayError', 'Failed to launch Apex Replay Debugger: ') +
          (e instanceof Error ? e.message : String(e))
      );
      logWarn('Logs: replay failed ->', e instanceof Error ? e.message : String(e));
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
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
      <title>Apex Logs</title>
      </head>
      <body>
      <div id="root"></div>
      <script src="${scriptUri}"></script>
      </body>
      </html>`;
  }

  public async sendOrgs() {
    try {
      const orgs = await listOrgs();
      const selected =
        this.selectedOrg || orgs.find(o => o.isDefaultUsername)?.username || orgs[0]?.username || undefined;
      this.post({ type: 'orgs', data: orgs, selected });
    } catch {
      this.post({ type: 'orgs', data: [], selected: this.selectedOrg });
    }
  }

  // Expose for command integration
  public setSelectedOrg(username?: string) {
    this.selectedOrg = username;
    try {
      void (this.context as any)?.globalState?.update?.(SELECTED_ORG_KEY, username);
    } catch {
      // ignore missing globalState in tests
    }
  }

  public async tailLogs() {
    await vscode.commands.executeCommand('workbench.view.extension.salesforceTailPanel');
    await vscode.commands.executeCommand('workbench.viewsService.openView', 'sfLogTail');
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
