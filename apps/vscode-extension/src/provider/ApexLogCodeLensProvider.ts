import * as vscode from 'vscode';
import { isApexLogDocument } from '../utils/workspace';
import { localize } from '../utils/localize';

export class ApexLogCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
    if (token.isCancellationRequested || !isApexLogDocument(document)) {
      return [];
    }
    const command: vscode.Command = {
      title: localize('openLogInViewer.codeLensTitle', 'Open in Apex Log Viewer'),
      command: 'sfLogs.openLogInViewer',
      arguments: [document.uri]
    };
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), command)];
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
