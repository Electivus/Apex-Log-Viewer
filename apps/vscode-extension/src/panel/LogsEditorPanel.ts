import * as vscode from 'vscode';
import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { localize } from '../../../../src/utils/localize';

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

  private readonly panel: vscode.WebviewPanel;
  private readonly controller: SfLogsViewProvider;

  private constructor(context: vscode.ExtensionContext, options?: ShowOptions) {
    this.controller = new SfLogsViewProvider(context);
    if (typeof options?.selectedOrg === 'string' && options.selectedOrg.trim()) {
      this.controller.setSelectedOrg(options.selectedOrg);
    }

    this.panel = vscode.window.createWebviewPanel(
      LogsEditorPanel.viewType,
      localize('salesforce.logs.view.name', 'Electivus Apex Logs'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    this.controller.resolveWebviewPanel(this.panel);
    this.panel.onDidDispose(() => this.dispose());
    context.subscriptions.push(this.panel);
  }

  private reveal(): void {
    this.panel.reveal(undefined, false);
  }

  private async syncSelectedOrg(selectedOrg?: string): Promise<void> {
    await this.controller.syncSelectedOrg(selectedOrg);
  }

  private dispose(): void {
    if (LogsEditorPanel.instance === this) {
      LogsEditorPanel.instance = undefined;
    }
    this.controller.dispose();
  }
}
