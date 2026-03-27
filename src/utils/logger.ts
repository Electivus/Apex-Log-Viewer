import * as vscode from 'vscode';
import { stringifyUnknown } from './error';

// Centralized LogOutputChannel for the extension
const channel: vscode.LogOutputChannel = vscode.window.createOutputChannel('Electivus Apex Log Viewer', { log: true });
let traceEnabled = false;

function fmt(parts: unknown[]): string {
  const mapped = parts.map(p => {
    if (p instanceof Error) {
      return `${p.name}: ${p.message}` + (p.stack ? `\n${p.stack}` : '');
    }
    return stringifyUnknown(p);
  });
  return mapped.join(' ');
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
