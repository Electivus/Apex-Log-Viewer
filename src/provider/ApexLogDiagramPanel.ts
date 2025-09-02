import * as vscode from 'vscode';
import { parseApexLogToGraph } from '../shared/apexLogParser';
import type { DiagramWebviewToExtensionMessage } from '../shared/diagramMessages';
import { buildWebviewHtml } from '../utils/webviewHtml';
import { logInfo, logWarn } from '../utils/logger';

export class ApexLogDiagramPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private changeSub?: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    try {
      this.changeSub?.dispose();
    } catch {}
    try {
      this.panel?.dispose();
    } catch {}
    this.panel = undefined;
    this.changeSub = undefined;
  }

  private isApexLog(doc: vscode.TextDocument): boolean {
    const name = (doc.fileName || '').toLowerCase();
    if (!/\.log$/.test(name)) return false;
    const head = doc.getText(new vscode.Range(0, 0, Math.min(10, doc.lineCount), 0));
    return /APEX_CODE\s*,/i.test(head) || /\|EXECUTION_STARTED\|/.test(head);
  }

  async showForActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await this.showForDocument(editor.document);
  }

  async showForDocument(doc: vscode.TextDocument): Promise<void> {
    if (!this.isApexLog(doc)) {
      logInfo('Diagram panel: not an Apex log ->', doc.fileName);
      void vscode.window.showInformationMessage('Open a Salesforce Apex .log to show the diagram.');
      return;
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'apexLogDiagram',
        'Apex Log Diagram',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        }
      );
      this.panel.webview.html = buildWebviewHtml(
        this.panel.webview,
        this.context.extensionUri,
        'diagram.js',
        'Apex Log Diagram'
      );
      this.panel.onDidDispose(() => this.dispose());
      this.panel.webview.onDidReceiveMessage((msg: DiagramWebviewToExtensionMessage) => {
        if (msg?.type === 'ready') {
          try {
            const graph = parseApexLogToGraph(doc.getText(), 100000);
            this.panel?.webview.postMessage({ type: 'graph', graph });
          } catch (e) {
            logWarn('Diagram panel: parse failed ->', e instanceof Error ? e.message : String(e));
          }
        }
      });
    }
    // Update when the document changes
    this.changeSub?.dispose();
    this.changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === doc.uri.toString() && this.panel) {
        try {
          const graph = parseApexLogToGraph(e.document.getText(), 100000);
          this.panel.webview.postMessage({ type: 'graph', graph });
        } catch (e2) {
          logWarn('Diagram panel: update parse failed ->', e2 instanceof Error ? e2.message : String(e2));
        }
      }
    });

    // Post initial graph if the panel already exists
    try {
      const graph = parseApexLogToGraph(doc.getText(), 100000);
      this.panel.webview.postMessage({ type: 'graph', graph });
    } catch (e) {
      logWarn('Diagram panel: initial parse failed ->', e instanceof Error ? e.message : String(e));
    }
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }
}
