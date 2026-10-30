import * as vscode from 'vscode';
import type { WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';
import { disposeAll } from './disposeAll';

/** The provider an editor tab hosts: the same one that serves the sidebar or bottom view. */
export interface SessionEditorController {
  resolveWebviewPanel(panel: vscode.WebviewPanel, replaceAfterReadyTimeout?: () => void | Promise<void>): void;
  setSelectedOrg(username?: string): void;
  syncSelectedOrg(username?: string): Promise<void>;
  getWebviewDiagnosticState(): WebviewProviderDiagnosticState;
  dispose(): void;
}

export interface SessionEditorPanelConfig {
  viewType: string;
  /** Localized when the panel is created. */
  title: () => string;
  createController(context: vscode.ExtensionContext): SessionEditorController;
}

export interface SessionEditorShowOptions {
  selectedOrg?: string;
}

/**
 * The editor tab of a surface hosted by a Webview Session: one tab at a time, reopening it reveals the tab and
 * syncs the org, and a tab whose webview never became ready is replaced once through the host's recovery.
 */
export function createSessionEditorPanel(config: SessionEditorPanelConfig) {
  let context: vscode.ExtensionContext | undefined;
  let instance: SessionEditorInstance | undefined;

  class SessionEditorInstance {
    private readonly controller: SessionEditorController;
    private panel: vscode.WebviewPanel;
    private panelDisposables: vscode.Disposable[] = [];
    private recreating = false;
    private retryAttempted = false;

    constructor(
      private readonly extensionContext: vscode.ExtensionContext,
      options?: SessionEditorShowOptions
    ) {
      this.controller = config.createController(extensionContext);
      if (typeof options?.selectedOrg === 'string' && options.selectedOrg.trim()) {
        this.controller.setSelectedOrg(options.selectedOrg);
      }
      this.panel = this.createPanel();
      this.bindPanel(this.panel);
    }

    get diagnosticState(): WebviewProviderDiagnosticState {
      return this.controller.getWebviewDiagnosticState();
    }

    reveal(): void {
      this.panel.reveal(undefined, false);
    }

    syncSelectedOrg(selectedOrg?: string): Promise<void> {
      return this.controller.syncSelectedOrg(selectedOrg);
    }

    private createPanel(): vscode.WebviewPanel {
      const panel = vscode.window.createWebviewPanel(
        config.viewType,
        config.title(),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media')]
        }
      );
      this.extensionContext.subscriptions.push(panel);
      return panel;
    }

    private bindPanel(panel: vscode.WebviewPanel): void {
      disposeAll(this.panelDisposables);
      this.panel = panel;
      this.controller.resolveWebviewPanel(panel, () => this.handleReadyTimeout(panel));
      this.panelDisposables.push(panel.onDidDispose(() => this.handlePanelDisposed()));
    }

    private async handleReadyTimeout(panel: vscode.WebviewPanel): Promise<void> {
      if (panel !== this.panel || this.retryAttempted || this.recreating || !panel.visible) {
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
      if (instance === this) {
        instance = undefined;
      }
      disposeAll(this.panelDisposables);
      this.controller.dispose();
    }
  }

  return {
    initialize(extensionContext: vscode.ExtensionContext): void {
      context = extensionContext;
    },

    getDiagnosticState(): WebviewProviderDiagnosticState | undefined {
      return instance?.diagnosticState;
    },

    async show(options?: SessionEditorShowOptions): Promise<void> {
      if (!context) {
        return;
      }
      if (instance) {
        instance.reveal();
        await instance.syncSelectedOrg(options?.selectedOrg);
        return;
      }
      instance = new SessionEditorInstance(context, options);
    }
  };
}
