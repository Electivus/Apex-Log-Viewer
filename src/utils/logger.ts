import * as vscode from 'vscode';

// Centralized OutputChannel for the extension
const channel = vscode.window.createOutputChannel('Apex Log Viewer');
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

function now(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function logInfo(...parts: unknown[]): void {
  channel.appendLine(`[${now()}] INFO  ${fmt(parts)}`);
}

export function logWarn(...parts: unknown[]): void {
  channel.appendLine(`[${now()}] WARN  ${fmt(parts)}`);
}

export function logError(...parts: unknown[]): void {
  channel.appendLine(`[${now()}] ERROR ${fmt(parts)}`);
}

export function showOutput(preserveFocus: boolean = false): void {
  channel.show(preserveFocus);
}

export function disposeLogger(): void {
  channel.dispose();
}

export function setTraceEnabled(enabled: boolean): void {
  traceEnabled = !!enabled;
  channel.appendLine(`[${now()}] INFO  Trace logging ${traceEnabled ? 'enabled' : 'disabled'}`);
}

export function isTraceEnabled(): boolean {
  return traceEnabled;
}

export function logTrace(...parts: unknown[]): void {
  if (!traceEnabled) {
    return;
  }
  channel.appendLine(`[${now()}] TRACE ${fmt(parts)}`);
}
