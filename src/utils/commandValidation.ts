import * as vscode from 'vscode';
import { localize } from './localize';
import { getErrorMessage } from './error';
import { logError, logWarn } from './logger';
import { safeSendException } from '../shared/telemetry';

export function requireOrgSelected(getOrg: () => string | undefined): boolean {
  const org = getOrg();
  if (!org) {
    void vscode.window.showErrorMessage(
      localize('noOrgSelected', 'Electivus Apex Logs: No Salesforce org selected')
    );
    return false;
  }
  return true;
}

interface HandleOptions {
  logMessage: string;
  userMessage: string;
  log?: typeof logError | typeof logWarn;
  telemetryEvent?: string;
  telemetryCode?: string;
}

export async function handleCommandError<T>(
  fn: () => Promise<T>,
  { logMessage, userMessage, log = logError, telemetryEvent, telemetryCode }: HandleOptions
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const msg = getErrorMessage(e);
    log(logMessage, '->', msg);
    void vscode.window.showErrorMessage(userMessage);
    if (telemetryEvent) {
      const props = telemetryCode ? { code: telemetryCode } : undefined;
      safeSendException(telemetryEvent, props);
    }
    return undefined;
  }
}

