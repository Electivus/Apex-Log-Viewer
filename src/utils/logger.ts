import * as vscode from 'vscode';

// Centralized LogOutputChannel for the extension
const channel: vscode.LogOutputChannel = vscode.window.createOutputChannel('Electivus Apex Log Viewer', { log: true });
let traceEnabled = false;

function fmt(parts: unknown[]): string {
  try {
    const mapped = parts.map(p => {
      if (p instanceof Error) {
        return `${p.name}: ${p.message}` + (p.stack ? `\n${p.stack}` : '');
      }
      if (typeof p === 'object') {
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      }
      return String(p);
    });
    return mapped.join(' ');
  } catch {
    return parts.map(p => String(p)).join(' ');
  }
}

export function logInfo(...parts: unknown[]): void {
  channel.info(fmt(parts));
}

export function logWarn(...parts: unknown[]): void {
  channel.warn(fmt(parts));
}

export function logError(...parts: unknown[]): void {
  channel.error(fmt(parts));
}

export function showOutput(preserveFocus: boolean = false): void {
  channel.show(preserveFocus);
}

export function disposeLogger(): void {
  channel.dispose();
}

export function setTraceEnabled(enabled: boolean): void {
  traceEnabled = !!enabled;
  channel.info(`Trace logging ${traceEnabled ? 'enabled' : 'disabled'}`);
}

export function isTraceEnabled(): boolean {
  return traceEnabled;
}

export function logTrace(...parts: unknown[]): void {
  if (!traceEnabled) {
    return;
  }
  channel.trace(fmt(parts));
}
