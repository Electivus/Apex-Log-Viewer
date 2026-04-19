import * as vscode from 'vscode';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { localize } from '../../../../src/utils/localize';
import { disposeAll } from './disposeAll';

interface ShowOptions {
  selectedOrg?: string;
}

export class LogsEditorPanel {
  private static context: vscode.ExtensionContext | undefined;
  private static instance: LogsEditorPanel | undefined;
  private static readonly viewType = 'sfLogViewer.editorPanel';

  static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  static async show(options?: ShowOptions): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }

    if (this.instance) {
      this.instance.reveal();
      await this.instance.syncSelectedOrg(options?.selectedOrg);
      return;
    }

    this.instance = new LogsEditorPanel(context, options);
  }

  private readonly controller: SfLogsViewProvider;
  private readonly context: vscode.ExtensionContext;
  private readonly instanceDisposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel;
  private panelDisposables: vscode.Disposable[] = [];
  private recreating = false;
  private retryAttempted = false;

  private constructor(context: vscode.ExtensionContext, options?: ShowOptions) {
    this.context = context;
    this.controller = new SfLogsViewProvider(context);
    if (typeof options?.selectedOrg === 'string' && options.selectedOrg.trim()) {
      this.controller.setSelectedOrg(options.selectedOrg);
    }
    this.instanceDisposables.push(
      this.controller.onDidReadyTimeout(() => {
        void this.handleReadyTimeout();
      })
    );

    this.panel = this.createPanel();
    this.bindPanel(this.panel);
  }

  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      LogsEditorPanel.viewType,
      localize('salesforce.logs.view.name', 'Electivus Apex Logs'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      }
    );
    this.context.subscriptions.push(panel);
    return panel;
  }

  private reveal(): void {
    this.panel.reveal(undefined, false);
  }

  private async syncSelectedOrg(selectedOrg?: string): Promise<void> {
    await this.controller.syncSelectedOrg(selectedOrg);
  }

  private bindPanel(panel: vscode.WebviewPanel): void {
    disposeAll(this.panelDisposables);
    this.panel = panel;
    this.controller.resolveWebviewPanel(panel);
    this.panelDisposables.push(
      panel.onDidDispose(() => {
        this.handlePanelDisposed();
      })
    );
  }

  private async handleReadyTimeout(): Promise<void> {
    if (this.retryAttempted || this.recreating || !this.panel.visible) {
      return;
    }
    this.retryAttempted = true;
    this.recreating = true;
    const nextPanel = this.createPanel();
    const oldPanel = this.panel;
    this.bindPanel(nextPanel);
    try {
      oldPanel.dispose();
    } finally {
      this.recreating = false;
    }
  }

  private handlePanelDisposed(): void {
    if (this.recreating) {
      return;
    }
    this.dispose();
  }

  private dispose(): void {
    if (LogsEditorPanel.instance === this) {
      LogsEditorPanel.instance = undefined;
    }
    disposeAll(this.panelDisposables);
    disposeAll(this.instanceDisposables);
    this.controller.dispose();
  }
}
