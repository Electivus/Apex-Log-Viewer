#!/usr/bin/env node
// Real-org lever for Custom Logs. Needs the dedicated Nebula scratch orgs authenticated in `sf`.
//
//   node scripts/custom-logs-smoke.mjs --capture-fixtures   refresh the describe fixtures core tests replay
//
// Every call is a read: SOQL, describe and the `sf electivus custom-log` commands.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const SF_BIN = process.env.ALV_SF_BIN_PATH || 'sf';
const FIXTURE_DIR = path.join(REPO_ROOT, 'packages/core/test/fixtures/customLogs');

const HARNESS = [
  { fixture: 'unlocked-admin', alias: 'alv-nebula-unlocked', objects: ['Log__c', 'LogEntry__c', 'App_Log__c', 'User'] },
  { fixture: 'unlocked-enduser', alias: 'alv-nebula-unlocked-enduser', objects: ['Log__c', 'LogEntry__c'] },
  { fixture: 'managed-admin', alias: 'alv-nebula-managed', objects: ['Nebula__Log__c', 'Nebula__LogEntry__c'] },
  {
    fixture: 'managed-enduser',
    alias: 'alv-nebula-managed-enduser',
    objects: ['Nebula__Log__c', 'Nebula__LogEntry__c']
  }
];

// Anything that would identify a harness org must never reach a committed fixture.
const ORG_IDENTIFIERS = [
  /@[\w-]+\.(?:com|org|net)\b/i,
  /\b00D[A-Za-z0-9]{12,15}\b/,
  /\.salesforce\.com/i,
  /\b005[A-Za-z0-9]{12,15}\b/
];

async function sfJson(args) {
  try {
    const { stdout } = await execFileAsync(SF_BIN, [...args, '--json'], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout).result;
  } catch (error) {
    const detail = error.stdout ? JSON.parse(error.stdout) : undefined;
    throw new Error(`sf ${args.join(' ')} failed: ${detail?.message ?? error.message}`);
  }
}

/** The part of describe that core reads. */
function trimDescribe(describe) {
  return {
    name: describe.name,
    keyPrefix: describe.keyPrefix,
    fields: describe.fields.map(field => ({
      name: field.name,
      label: field.label,
      type: field.type,
      ...(field.relationshipName ? { relationshipName: field.relationshipName } : {}),
      referenceTo: field.referenceTo,
      sortable: field.sortable,
      filterable: field.filterable,
      picklistValues:
        field.type === 'picklist' ? field.picklistValues.map(({ value, active }) => ({ value, active })) : []
    }))
  };
}

/** One field per line, so a refreshed fixture reviews as a diff of fields. */
function formatFixture(describes) {
  const objects = Object.entries(describes).map(([name, describe]) => {
    const fields = describe.fields.map(field => `      ${JSON.stringify(field)}`).join(',\n');
    const head = `"name": ${JSON.stringify(describe.name)}, "keyPrefix": ${JSON.stringify(describe.keyPrefix)}`;
    return `  ${JSON.stringify(name)}: {\n    ${head},\n    "fields": [\n${fields}\n    ]\n  }`;
  });
  return `{\n${objects.join(',\n')}\n}\n`;
}

async function captureFixtures() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  for (const { fixture, alias, objects } of HARNESS) {
    const describes = {};
    for (const object of objects) {
      describes[object] = trimDescribe(
        await sfJson(['sobject', 'describe', '--sobject', object, '--target-org', alias])
      );
    }
    const text = formatFixture(describes);
    const leak = ORG_IDENTIFIERS.find(pattern => pattern.test(text));
    if (leak) throw new Error(`${fixture}: the describe output matches ${leak}; refusing to write it.`);
    await fs.writeFile(path.join(FIXTURE_DIR, `describe-${fixture}.json`), text);
    console.log(
      `describe-${fixture}.json: ${Object.entries(describes)
        .map(([name, d]) => `${name} ${d.fields.length}`)
        .join(', ')}`
    );
  }
}

const args = process.argv.slice(2);
if (args.includes('--capture-fixtures')) {
  await captureFixtures();
} else {
  console.error('Usage: node scripts/custom-logs-smoke.mjs --capture-fixtures');
  process.exitCode = 2;
}
