import type * as vscode from 'vscode';
import type { LogDiagnostic } from './logTriage';

export type LogViewerTriagePayload = {
  hasErrors: boolean;
  primaryReason?: string;
  reasons: LogDiagnostic[];
};

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
      triage?: LogViewerTriagePayload;
    }
  | { type: 'logViewerTriageUpdate'; logId: string; triage?: LogViewerTriagePayload }
  | { type: 'logViewerError'; message: string };

export type LogViewerFromWebviewMessage =
  | { type: 'logViewerReady' }
  | { type: 'logViewerViewRaw' }
  | { type: 'logViewerCopyText'; text: string };

export interface LogViewerPanelContext {
  extensionUri: vscode.Uri;
}
