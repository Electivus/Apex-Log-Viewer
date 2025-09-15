import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { logWarn } from '../utils/logger';

let reporter: TelemetryReporter | undefined;

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
