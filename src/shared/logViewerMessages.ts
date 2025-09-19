import type * as vscode from 'vscode';

export type LogViewerToWebviewMessage =
  | {
      type: 'logViewerInit';
      logId: string;
      locale: string;
      fileName: string;
      logUri?: string;
      lines?: string[];
      metadata?: {
        sizeBytes?: number;
        modifiedAt?: string;
      };
    }
  | { type: 'logViewerError'; message: string };

export type LogViewerFromWebviewMessage =
  | { type: 'logViewerReady' }
  | { type: 'logViewerViewRaw' }
  | { type: 'logViewerCopyText'; text: string };

export interface LogViewerPanelContext {
  extensionUri: vscode.Uri;
}
