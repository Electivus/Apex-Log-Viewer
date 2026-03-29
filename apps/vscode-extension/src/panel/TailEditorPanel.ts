import * as vscode from 'vscode';
import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import { localize } from '../../../../src/utils/localize';

interface ShowOptions {
  selectedOrg?: string;
}

export class TailEditorPanel {
  private static context: vscode.ExtensionContext | undefined;
  private static instance: TailEditorPanel | undefined;
  private static readonly viewType = 'sfLogTail.editorPanel';

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

    this.instance = new TailEditorPanel(context, options);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly controller: SfLogTailViewProvider;

  private constructor(context: vscode.ExtensionContext, options?: ShowOptions) {
    this.controller = new SfLogTailViewProvider(context);
    if (typeof options?.selectedOrg === 'string' && options.selectedOrg.trim()) {
      this.controller.setSelectedOrg(options.selectedOrg);
    }

    this.panel = vscode.window.createWebviewPanel(
      TailEditorPanel.viewType,
      localize('salesforce.tail.view.name', 'Electivus Apex Logs Tail'),
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
    if (TailEditorPanel.instance === this) {
      TailEditorPanel.instance = undefined;
    }
    this.controller.dispose();
  }
}
