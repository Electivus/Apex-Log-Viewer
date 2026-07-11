import * as vscode from 'vscode';

export function localize(_legacyKey: string, message: string, ...args: Array<string | number | boolean>): string {
  if (typeof vscode.l10n?.t === 'function') {
    return vscode.l10n.t(message, ...args);
  }

  return message.replace(/\{(\d+)\}/g, (match, index) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}
