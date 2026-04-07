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

const MAX_CLIPBOARD_COPY_TEXT_LENGTH = 1_000_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

export function parseLogViewerFromWebviewMessage(raw: unknown): LogViewerFromWebviewMessage | undefined {
  const message = asRecord(raw);
  if (!message) {
    return undefined;
  }

  switch (message.type) {
    case 'logViewerReady':
      return { type: 'logViewerReady' };
    case 'logViewerViewRaw':
      return { type: 'logViewerViewRaw' };
    case 'logViewerCopyText': {
      const text = parseString(message.text, MAX_CLIPBOARD_COPY_TEXT_LENGTH);
      return text && text.length > 0 ? { type: 'logViewerCopyText', text } : undefined;
    }
    default:
      return undefined;
  }
}
