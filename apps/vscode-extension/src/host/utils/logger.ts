import * as vscode from 'vscode';
import { stringifyUnknown } from './error';
import { redactSecrets } from './redact';

// Centralized LogOutputChannel for the extension
const channel: vscode.LogOutputChannel = vscode.window.createOutputChannel('Electivus Apex Log Viewer', { log: true });
let traceEnabled = false;
const MAX_RECENT_LOG_ENTRIES = 300;

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'trace';
  message: string;
}

const recentLogEntries: LogEntry[] = [];

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
  writeLog('info', parts);
}

export function logWarn(...parts: unknown[]): void {
  writeLog('warn', parts);
}

export function logError(...parts: unknown[]): void {
  writeLog('error', parts);
}

export function showOutput(preserveFocus: boolean = false): void {
  channel.show(preserveFocus);
}

export function disposeLogger(): void {
  channel.dispose();
}

export function setTraceEnabled(enabled: boolean): void {
  traceEnabled = !!enabled;
  writeLog('info', [`Trace logging ${traceEnabled ? 'enabled' : 'disabled'}`]);
}

export function isTraceEnabled(): boolean {
  return traceEnabled;
}

export function logTrace(...parts: unknown[]): void {
  if (!traceEnabled) {
    return;
  }
  writeLog('trace', parts);
}

export function getRecentLogEntries(): LogEntry[] {
  return recentLogEntries.slice();
}

function writeLog(level: LogEntry['level'], parts: unknown[]): void {
  const message = redactSecrets(level === 'trace' ? `[trace] ${fmt(parts)}` : fmt(parts));
  recentLogEntries.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
  if (recentLogEntries.length > MAX_RECENT_LOG_ENTRIES) {
    recentLogEntries.splice(0, recentLogEntries.length - MAX_RECENT_LOG_ENTRIES);
  }
  switch (level) {
    case 'warn':
      channel.warn(message);
      break;
    case 'error':
      channel.error(message);
      break;
    default:
      channel.info(message);
      break;
  }
}
