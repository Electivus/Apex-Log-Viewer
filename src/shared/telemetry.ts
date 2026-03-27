import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { logWarn } from '../utils/logger';

interface TelemetryFieldSchema {
  required?: boolean;
  values?: string[];
  pattern?: string;
}

interface TelemetryEventSchema {
  properties?: Record<string, TelemetryFieldSchema>;
  measurements?: Record<string, TelemetryFieldSchema>;
}

interface TelemetryCatalog {
  commonProperties?: Record<string, TelemetryFieldSchema>;
  extensionId?: string;
  events?: Record<string, TelemetryEventSchema>;
}

type PreparedEvent = {
  measurements?: Record<string, number>;
  properties?: Record<string, string>;
};

let reporter: TelemetryReporter | undefined;
let catalog: TelemetryCatalog | undefined;
const warningKeys = new Set<string>();

function isExplicitTestTelemetryEnabled(): boolean {
  return process.env.ALV_ENABLE_TEST_TELEMETRY === '1';
}

function isNonProductionMode(context: vscode.ExtensionContext): boolean {
  return (
    context.extensionMode === vscode.ExtensionMode.Development || context.extensionMode === vscode.ExtensionMode.Test
  );
}

function warnOnce(key: string, message: string): void {
  if (warningKeys.has(key)) {
    return;
  }
  warningKeys.add(key);
  logWarn(message);
}

function getConnectionString(context: vscode.ExtensionContext): string | undefined {
  if (isNonProductionMode(context)) {
    const testConn = process.env.ALV_TEST_TELEMETRY_CONNECTION_STRING?.trim();
    return testConn || undefined;
  }
  const envConn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || process.env.VSCODE_TELEMETRY_CONNECTION_STRING;
  if (envConn) return envConn;
  const anyPkg = context.extension.packageJSON as Record<string, unknown>;
  const conn =
    anyPkg && typeof anyPkg.telemetryConnectionString === 'string' ? anyPkg.telemetryConnectionString : undefined;
  return conn;
}

function pushUniquePath(paths: string[], value: string | undefined): void {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return;
  }
  if (!paths.includes(normalized)) {
    paths.push(normalized);
  }
}

function getTelemetrySchemaPath(context: vscode.ExtensionContext): string {
  const candidateRoots: string[] = [];
  pushUniquePath(candidateRoots, (context.extension as { extensionPath?: string } | undefined)?.extensionPath);
  pushUniquePath(candidateRoots, (context as { extensionPath?: string } | undefined)?.extensionPath);
  pushUniquePath(candidateRoots, process.cwd());
  pushUniquePath(candidateRoots, path.resolve(__dirname, '..'));
  pushUniquePath(candidateRoots, path.resolve(__dirname, '../..'));

  const candidatePaths = candidateRoots.map(root => path.join(root, 'telemetry.json'));
  return candidatePaths.find(candidate => fs.existsSync(candidate)) || candidatePaths[0] || path.join(process.cwd(), 'telemetry.json');
}

function loadTelemetryCatalog(context: vscode.ExtensionContext): TelemetryCatalog | undefined {
  try {
    const schemaPath = getTelemetrySchemaPath(context);
    const raw = fs.readFileSync(schemaPath, 'utf8');
    const parsed = JSON.parse(raw) as TelemetryCatalog;
    if (!parsed || typeof parsed !== 'object' || !parsed.events || typeof parsed.events !== 'object') {
      warnOnce('telemetry:schema:invalid', 'Telemetry schema is missing the events catalog; telemetry is disabled.');
      return undefined;
    }
    return parsed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnOnce('telemetry:schema:load', `Failed loading telemetry schema; telemetry is disabled. ${msg}`);
    return undefined;
  }
}

function getEventSchema(name: string): TelemetryEventSchema | undefined {
  const schema = catalog?.events?.[name];
  if (!schema) {
    warnOnce(`telemetry:event:${name}`, `Telemetry event "${name}" is not declared in telemetry.json; dropping it.`);
    return undefined;
  }
  return schema;
}

function isAllowedString(value: string, schema: TelemetryFieldSchema): boolean {
  if (Array.isArray(schema.values) && schema.values.length > 0 && !schema.values.includes(value)) {
    return false;
  }
  if (schema.pattern) {
    return new RegExp(schema.pattern).test(value);
  }
  return true;
}

function getPropertySchema(eventSchema: TelemetryEventSchema): Record<string, TelemetryFieldSchema> {
  return {
    ...(catalog?.commonProperties || {}),
    ...(eventSchema.properties || {})
  };
}

function prepareProperties(
  eventName: string,
  eventSchema: TelemetryEventSchema,
  properties: Record<string, string> | undefined,
  kind: 'error' | 'usage'
): Record<string, string> | null | undefined {
  const input: Record<string, string> = {};
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      input[key] = String(value);
    }
  }
  if (kind === 'error') {
    input.outcome = input.outcome || 'error';
  }
  if (isExplicitTestTelemetryEnabled()) {
    const testRunId = process.env.ALV_TEST_TELEMETRY_RUN_ID?.trim();
    if (testRunId) {
      input.testRunId = testRunId;
    }
  }

  const propertySchema = getPropertySchema(eventSchema);
  const output: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    const fieldSchema = propertySchema[key];
    if (!fieldSchema) {
      warnOnce(
        `telemetry:property:${eventName}:${key}`,
        `Telemetry property "${key}" is not declared for "${eventName}"; dropping it.`
      );
      continue;
    }
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      continue;
    }
    if (!isAllowedString(normalized, fieldSchema)) {
      warnOnce(
        `telemetry:property:value:${eventName}:${key}:${normalized}`,
        `Telemetry property "${key}" for "${eventName}" has a disallowed value; dropping it.`
      );
      continue;
    }
    output[key] = normalized;
  }

  for (const [key, fieldSchema] of Object.entries(propertySchema)) {
    if (fieldSchema.required && !output[key]) {
      warnOnce(
        `telemetry:property:required:${eventName}:${key}`,
        `Telemetry event "${eventName}" is missing required property "${key}"; dropping it.`
      );
      return null;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function prepareMeasurements(
  eventName: string,
  eventSchema: TelemetryEventSchema,
  measurements: Record<string, number> | undefined
): Record<string, number> | undefined {
  if (!measurements) {
    return undefined;
  }
  const measurementSchema = eventSchema.measurements || {};
  const output: Record<string, number> = {};

  for (const [key, value] of Object.entries(measurements)) {
    const fieldSchema = measurementSchema[key];
    if (!fieldSchema) {
      warnOnce(
        `telemetry:measurement:${eventName}:${key}`,
        `Telemetry measurement "${key}" is not declared for "${eventName}"; dropping it.`
      );
      continue;
    }
    if (!Number.isFinite(value)) {
      warnOnce(
        `telemetry:measurement:value:${eventName}:${key}`,
        `Telemetry measurement "${key}" for "${eventName}" is not finite; dropping it.`
      );
      continue;
    }
    output[key] = value;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function prepareEvent(
  name: string,
  properties: Record<string, string> | undefined,
  measurements: Record<string, number> | undefined,
  kind: 'error' | 'usage'
): PreparedEvent | undefined {
  if (!catalog) {
    return undefined;
  }
  const eventSchema = getEventSchema(name);
  if (!eventSchema) {
    return undefined;
  }
  const preparedProperties = prepareProperties(name, eventSchema, properties, kind);
  if (preparedProperties === null) {
    return undefined;
  }
  const preparedMeasurements = prepareMeasurements(name, eventSchema, measurements);
  return {
    properties: preparedProperties,
    measurements: preparedMeasurements
  };
}

export function activateTelemetry(context: vscode.ExtensionContext) {
  try {
    if (isNonProductionMode(context) && !isExplicitTestTelemetryEnabled()) {
      return;
    }

    catalog = loadTelemetryCatalog(context);
    if (!catalog) {
      return;
    }

    const keyOrConn = getConnectionString(context);
    if (!keyOrConn) {
      if (isNonProductionMode(context) && isExplicitTestTelemetryEnabled()) {
        warnOnce(
          'telemetry:test:missing-connection',
          'Explicit test telemetry was enabled, but ALV_TEST_TELEMETRY_CONNECTION_STRING is missing.'
        );
      }
      return;
    }
    reporter = new TelemetryReporter(keyOrConn);
    context.subscriptions.push({
      dispose: () => reporter?.dispose()
    });
  } catch {
    // Never throw from telemetry init
  }
}

export function disposeTelemetry(): void {
  try {
    void reporter?.dispose();
  } catch {
    // ignore
  } finally {
    reporter = undefined;
    catalog = undefined;
    warningKeys.clear();
  }
}

export function sendEvent(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
): void {
  const event = prepareEvent(name, properties, measurements, 'usage');
  if (!event) {
    return;
  }
  reporter?.sendTelemetryEvent(name, event.properties, event.measurements);
}

export function sendException(name: string, properties?: Record<string, string>): void {
  const event = prepareEvent(name, properties, undefined, 'error');
  if (!event) {
    return;
  }
  reporter?.sendTelemetryErrorEvent(name, event.properties);
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
