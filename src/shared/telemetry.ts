import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { logWarn } from '../utils/logger';

let reporter: TelemetryReporter | undefined;
const commonProps: Record<string, string> = {};

// Hardcoded Application Insights key/connection string. This is not sensitive.
// Using the legacy instrumentation key format keeps setup simple while
// allowing the library to route to the correct backend.
const TELEMETRY_CONNECTION_STRING = 'InstrumentationKey=4bb6665c-300d-4506-b2d6-5a47198cccde;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=5a330611-dd73-4e8f-80d7-66263ce00474';

export function activateTelemetry(context: vscode.ExtensionContext) {
  try {
    // Initialize the reporter unconditionally and let VS Code telemetry level
    // control collection ("off", "crash", "error", "all").
    reporter = new TelemetryReporter(TELEMETRY_CONNECTION_STRING, [
      // Be extra cautious: drop common error-related fields if ever present.
      { lookup: /(errorName|errorMessage|errorStack)/gi },
      // Drop potential PII-ish fields if accidentally included.
      { lookup: /(username|orgId|instanceUrl|uri|url|file|path)/gi }
    ]);
    context.subscriptions.push({
      dispose: () => reporter?.dispose()
    });
    // Initialize common properties once
    try {
      const uiKind = vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop';
      commonProps.extensionId = context.extension.id ?? 'unknown';
      commonProps.extensionVersion = String((context.extension.packageJSON as any)?.version ?? '0.0.0');
      commonProps.vscodeVersion = vscode.version;
      commonProps.platform = process.platform;
      commonProps.arch = process.arch;
      commonProps.uiKind = uiKind;
      commonProps.remoteName = String(vscode.env.remoteName || 'none');
      commonProps.devMode = String(context.extensionMode === vscode.ExtensionMode.Development);
      commonProps.testMode = String(context.extensionMode === vscode.ExtensionMode.Test);
    } catch (_) {
      // ignore
    }
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
  const props = { ...commonProps, ...(properties ?? {}) };
  if (process.env.ALV_LOG_TELEMETRY) {
    try {
      // Avoid noisy JSON of big objects
      // eslint-disable-next-line no-console
      console.info(`[telemetry] ${name} props=${JSON.stringify(props)} meas=${JSON.stringify(measurements || {})}`);
    } catch {}
  }
  reporter?.sendTelemetryEvent(name, props, measurements);
}

export function sendException(name: string, properties?: Record<string, string>): void {
  // Avoid sending raw messages/stacks; send only a coarse-grained name/code.
  const props = { ...commonProps, ...(properties ?? {}) };
  if (process.env.ALV_LOG_TELEMETRY) {
    try {
      // eslint-disable-next-line no-console
      console.info(`[telemetry] ${name} ERROR props=${JSON.stringify(props)}`);
    } catch {}
  }
  reporter?.sendTelemetryErrorEvent(name, props);
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

/**
 * Tracks install/update events and activation duration.
 */
export async function trackStartup(
  context: vscode.ExtensionContext,
  activationStartMs: number,
  opts?: { hasWorkspace?: boolean }
): Promise<void> {
  try {
    const now = Date.now();
    const activationMs = now - activationStartMs;
    const current = String((context.extension.packageJSON as any)?.version ?? '0.0.0');
    const KEY = 'telemetry.lastVersion';
    const last = context.globalState.get<string>(KEY);
    if (!last) {
      safeSendEvent('extension.install', { version: current });
    } else if (last !== current) {
      safeSendEvent('extension.update', { from: last, to: current });
    }
    await context.globalState.update(KEY, current);
    const hasWorkspace = String(!!(opts?.hasWorkspace));
    safeSendEvent('extension.activate', { hasWorkspace }, { activationMs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logWarn('Failed to track startup telemetry ->', msg);
  }
}

/** Flush reporter queue. */
export async function flushTelemetry(): Promise<void> {
  try {
    await reporter?.dispose();
  } catch {
    // ignore
  }
}

/**
 * Helper to time an operation and send duration.
 */
export async function withDuration<T>(
  eventName: string,
  fn: () => Promise<T>,
  properties?: Record<string, string>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    safeSendEvent(eventName, properties, { durationMs: ms });
    return result;
  } catch (e) {
    const ms = Date.now() - start;
    safeSendException(`${eventName}.error`, properties);
    safeSendEvent(eventName, { ...(properties || {}), outcome: 'error' }, { durationMs: ms });
    throw e;
  }
}
