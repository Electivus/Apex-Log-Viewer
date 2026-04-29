import * as vscode from 'vscode';
import { stringifyUnknown } from './error';

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

function redactSensitiveText(message: string): string {
  const secretKeyNames = [
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'idToken',
    'id_token',
    'sessionId',
    'session_id',
    'sid',
    'clientSecret',
    'client_secret',
    'authorization',
    'authToken',
    'auth_token',
    'password'
  ].join('|');
  let redacted = message.replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s,;]+/gi, '$1[redacted]');
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]');
  redacted = redacted.replace(
    new RegExp(`(["']?(?:${secretKeyNames})["']?\\s*:\\s*["'])([^"']+)(["'])`, 'gi'),
    '$1[redacted]$3'
  );
  redacted = redacted.replace(new RegExp(`(\\b(?:${secretKeyNames})\\b\\s*=\\s*)([^\\s,;]+)`, 'gi'), '$1[redacted]');
  return redacted;
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
  const message = redactSensitiveText(level === 'trace' ? `[trace] ${fmt(parts)}` : fmt(parts));
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
