import assert from 'assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TelemetryFieldSchema {
  required?: boolean;
}

interface TelemetryEventSchema {
  measurements?: Record<string, TelemetryFieldSchema>;
  properties?: Record<string, TelemetryFieldSchema>;
}

interface TelemetryCatalog {
  commonProperties?: Record<string, TelemetryFieldSchema>;
  events: Record<string, TelemetryEventSchema>;
}

function readTelemetryCatalog(): TelemetryCatalog {
  const schemaPath = path.resolve(__dirname, '../../telemetry.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  return JSON.parse(raw) as TelemetryCatalog;
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') {
        continue;
      }
      collectSourceFiles(fullPath, acc);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function collectEmittedEventNames(): string[] {
  const srcRoot = path.resolve(__dirname, '../../src');
  const matcher = /safeSend(?:Event|Exception)\(\s*['"]([^'"]+)['"]/g;
  const emitted = new Set<string>();

  for (const filePath of collectSourceFiles(srcRoot)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const match of content.matchAll(matcher)) {
      const name = match[1];
      if (name) {
        emitted.add(name);
      }
    }
  }

  return [...emitted].sort((left, right) => left.localeCompare(right));
}

suite('telemetry contract', () => {
  test('catalog covers every emitted telemetry event', () => {
    const catalog = readTelemetryCatalog();
    const emitted = collectEmittedEventNames();
    const missing = emitted.filter(name => !catalog.events[name]);

    assert.deepEqual(missing, []);
  });

  test('catalog requires outcome for every declared event', () => {
    const catalog = readTelemetryCatalog();

    for (const [name, schema] of Object.entries(catalog.events)) {
      assert.equal(
        schema.properties?.outcome?.required,
        true,
        `Expected telemetry event "${name}" to require outcome.`
      );
    }
  });

  test('activation duration is modeled on extension.activate, not as a separate event', () => {
    const catalog = readTelemetryCatalog();

    assert.ok(catalog.events['extension.activate']);
    assert.ok(catalog.events['extension.activate']?.measurements?.durationMs);
    assert.equal(catalog.events['extension.activate.duration'], undefined);
  });

  test('catalog declares the test-only run identifier used by E2E telemetry validation', () => {
    const catalog = readTelemetryCatalog();

    assert.ok(catalog.commonProperties?.testRunId);
  });
});
