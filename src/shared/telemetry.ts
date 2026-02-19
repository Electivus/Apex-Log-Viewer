import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { logWarn } from '../utils/logger';

let reporter: TelemetryReporter | undefined;

function getConnectionString(context: vscode.ExtensionContext): string | undefined {
  // Prefer environment variables configured during packaging.
  const envConn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || process.env.VSCODE_TELEMETRY_CONNECTION_STRING;
  if (envConn) return envConn;
  // Fallback to packaged field set by CI (non-legacy): package.json.telemetryConnectionString
  const anyPkg = context.extension.packageJSON as any;
  const conn: string | undefined =
    anyPkg && typeof anyPkg.telemetryConnectionString === 'string' ? anyPkg.telemetryConnectionString : undefined;
  return conn;
}

export function activateTelemetry(context: vscode.ExtensionContext) {
  try {
    // Never send telemetry in Development or Test modes
    if (
      context.extensionMode === vscode.ExtensionMode.Development ||
      context.extensionMode === vscode.ExtensionMode.Test
    ) {
      return;
    }
    const keyOrConn = getConnectionString(context);
    if (!keyOrConn) {
      return; // No telemetry key configured – gracefully no-op
    }
    reporter = new TelemetryReporter(keyOrConn);
    context.subscriptions.push({
      dispose: () => reporter?.dispose()
    });
  } catch (e) {
    // Never throw from telemetry init
  }
}

export function disposeTelemetry(): void {
  try {
    reporter?.dispose();
  } catch {
    // ignore
  } finally {
    reporter = undefined;
  }
}

export function sendEvent(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
): void {
  reporter?.sendTelemetryEvent(name, properties, measurements);
}

export function sendException(name: string, properties?: Record<string, string>): void {
  // Avoid sending raw messages/stacks; send only a coarse-grained name/code.
  reporter?.sendTelemetryErrorEvent(name, properties);
}

export function safeSendEvent(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
): void {
  try {
    sendEvent(name, properties, measurements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn('Failed sending telemetry ->', msg);
  }
}

export function safeSendException(name: string, properties?: Record<string, string>): void {
  try {
    sendException(name, properties);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn('Failed sending telemetry ->', msg);
  }
}
