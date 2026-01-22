import * as vscode from 'vscode';
import { promises as fs, type Stats } from 'fs';
import * as path from 'path';
import { buildWebviewHtml } from '../utils/webviewHtml';
import { logInfo, logWarn } from '../utils/logger';
import { getErrorMessage } from '../utils/error';
import type { LogViewerFromWebviewMessage, LogViewerToWebviewMessage } from '../shared/logViewerMessages';

interface ShowOptions {
  logId: string;
  filePath: string;
  signal?: AbortSignal;
}

export class LogViewerPanel {
  private static context: vscode.ExtensionContext | undefined;
  private static panels = new Map<string, LogViewerPanel>();
  private static readonly viewType = 'sfLogViewer.logPanel';

  static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  static async show(options: ShowOptions): Promise<void> {
    const extensionUri = this.context?.extensionUri;
    if (!extensionUri) {
      // Fallback to raw text document when running outside extension activation (e.g., unit tests)
      if (options.signal?.aborted) {
        return;
      }
      try {
        const uri = vscode.Uri.file(options.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        const msg = getErrorMessage(err);
        logWarn('LogViewerPanel: fallback openTextDocument failed ->', msg);
        void vscode.window.showErrorMessage(`Failed to open Apex log: ${msg}`);
      }
      return;
    }

    if (options.signal?.aborted) {
      return;
    }

    let stats: Stats | undefined;
    try {
      stats = await fs.stat(options.filePath);
    } catch (err) {
      if ((options.signal as any)?.aborted) {
        return;
      }
      const msg = getErrorMessage(err);
      logWarn('LogViewerPanel: failed reading log file ->', msg);
      void vscode.window.showErrorMessage(`Failed to read Apex log: ${msg}`);
      return;
    }

    if (options.signal?.aborted) {
      return;
    }

    const key = options.filePath;
    const existing = this.panels.get(key);
    if (existing) {
      existing.update(stats);
      existing.reveal();
      logInfo('LogViewerPanel: revealed existing panel for', options.logId);
      return;
    }

    const panel = new LogViewerPanel(extensionUri, { ...options }, stats);
    this.panels.set(key, panel);
    logInfo('LogViewerPanel: created panel for', options.logId);
  }

  private panel: vscode.WebviewPanel;
  private readonly filePath: string;
  private readonly logId: string;
  private stats: Stats | undefined;
  private ready = false;
  private disposed = false;
  private cacheBust = Date.now();

  private constructor(
    extensionUri: vscode.Uri,
    options: ShowOptions,
    stats: Stats | undefined
  ) {
    this.logId = options.logId;
    this.filePath = options.filePath;
    this.stats = stats;

    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
    const logDirectoryUri = vscode.Uri.file(path.dirname(this.filePath));
    this.panel = vscode.window.createWebviewPanel(
      LogViewerPanel.viewType,
      this.buildTitle(),
      { viewColumn: column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), logDirectoryUri]
      }
    );
    this.panel.webview.html = buildWebviewHtml(this.panel.webview, extensionUri, 'logViewer.js', 'Apex Log Viewer');

    this.panel.onDidDispose(() => this.dispose());
    this.panel.onDidChangeViewState(() => {
      if (this.panel.active) {
        this.panel.title = this.buildTitle();
      }
    });

    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message as LogViewerFromWebviewMessage));

    LogViewerPanel.context?.subscriptions.push(this.panel);
  }

  private buildTitle(): string {
    const fileName = path.basename(this.filePath);
    return `Apex Log: ${fileName}`;
  }

  private buildLogUri(): string {
    const resourceWithCacheBust = vscode.Uri.file(this.filePath).with({ query: `v=${this.cacheBust}` });
    return this.panel.webview.asWebviewUri(resourceWithCacheBust).toString();
  }

  private async onMessage(message: LogViewerFromWebviewMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    switch (message.type) {
      case 'logViewerReady':
        this.ready = true;
        this.postInit();
        break;
      case 'logViewerViewRaw':
        await this.viewRaw();
        break;
      case 'logViewerCopyText':
        if (typeof message.text === 'string' && message.text.length > 0) {
          try {
            await vscode.env.clipboard.writeText(message.text);
            logInfo('LogViewerPanel: copied text to clipboard');
          } catch (err) {
            logWarn('LogViewerPanel: copy failed ->', getErrorMessage(err));
          }
        }
        break;
    }
  }

  private async viewRaw(): Promise<void> {
    try {
      const uri = vscode.Uri.file(this.filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
      logInfo('LogViewerPanel: opened raw log for', this.logId);
    } catch (err) {
      const msg = getErrorMessage(err);
      logWarn('LogViewerPanel: viewRaw failed ->', msg);
      void vscode.window.showErrorMessage(`Failed to open raw log: ${msg}`);
    }
  }

  private postInit(): void {
    if (!this.ready || this.disposed) {
      return;
    }
    const message: LogViewerToWebviewMessage = {
      type: 'logViewerInit',
      logId: this.logId,
      locale: vscode.env.language,
      fileName: path.basename(this.filePath),
      logUri: this.buildLogUri(),
      metadata: this.stats
        ? {
            sizeBytes: this.stats.size,
            modifiedAt: this.stats.mtime.toISOString()
          }
        : undefined
    };
    void this.panel.webview.postMessage(message);
  }

  private update(stats: Stats | undefined): void {
    this.stats = stats;
    this.cacheBust = Date.now();
    if (this.ready) {
      this.postInit();
    }
  }

  private reveal(): void {
    this.panel.reveal(undefined, true);
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    LogViewerPanel.panels.delete(this.filePath);
  }
}
