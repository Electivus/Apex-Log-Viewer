#!/usr/bin/env node
// Real-org lever for Custom Logs. Needs the dedicated Nebula scratch orgs authenticated in `sf`
// and the plugin built (`pnpm run build:sf-plugin`).
//
//   node scripts/custom-logs-smoke.mjs                       the four harness aliases
//   node scripts/custom-logs-smoke.mjs alv-nebula-managed    only these aliases
//   node scripts/custom-logs-smoke.mjs --capture-fixtures    refresh the describe fixtures core tests replay
//
// It runs `sf electivus custom-log` through the built plugin, once per alias, and checks what the
// commands return. App_Log__c is mapped through a temporary project directory, never the repo's
// sfdx-project.json. Every call is a read: SOQL, describe and the custom-log commands.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const SF_BIN = process.env.ALV_SF_BIN_PATH || 'sf';
const FIXTURE_DIR = path.join(REPO_ROOT, 'packages/core/test/fixtures/customLogs');

const CLI = path.join(REPO_ROOT, 'packages/sf-plugin/bin/run.js');

/** `source` is the built-in source id the org must detect; `admin` reads every field, an end user is a LoggerEndUser. */
const HARNESS = [
  {
    fixture: 'unlocked-admin',
    alias: 'alv-nebula-unlocked',
    source: 'nebula',
    admin: true,
    appLog: true,
    objects: ['Log__c', 'LogEntry__c', 'App_Log__c', 'User']
  },
  {
    fixture: 'unlocked-enduser',
    alias: 'alv-nebula-unlocked-enduser',
    source: 'nebula',
    admin: false,
    objects: ['Log__c', 'LogEntry__c']
  },
  {
    fixture: 'managed-admin',
    alias: 'alv-nebula-managed',
    source: 'nebula-managed',
    admin: true,
    objects: ['Nebula__Log__c', 'Nebula__LogEntry__c']
  },
  {
    fixture: 'managed-enduser',
    alias: 'alv-nebula-managed-enduser',
    source: 'nebula-managed',
    admin: false,
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

// ---------------------------------------------------------------------------------------------
// Smoke

const results = [];
const observed = { longValues: new Set(), payloads: new Set(), apexLog: new Set() };

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`
  );
  return Boolean(ok);
}

/** One custom-log command through the built plugin. `cwd` decides which sfdx-project.json it reads. */
async function cli(command, args, { org, cwd }) {
  const argv = [CLI, 'electivus', 'custom-log', command, ...args, '--target-org', org, '--json'];
  try {
    const { stdout } = await execFileAsync(process.execPath, argv, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, result: JSON.parse(stdout).result };
  } catch (error) {
    const body = error.stdout ? JSON.parse(error.stdout) : {};
    return { ok: false, code: body.code, message: body.message ?? error.message };
  }
}

const sourceIds = sources => sources.map(source => `${source.id}:${source.state}`);

async function apexLogRequestIds(alias) {
  const records = (
    await sfJson([
      'data',
      'query',
      '--use-tooling-api',
      '--target-org',
      alias,
      '--query',
      'SELECT RequestIdentifier FROM ApexLog'
    ])
  ).records;
  return new Set(records.map(record => record.RequestIdentifier));
}

async function smokeNebula({ alias, source, admin }, emptyDir) {
  const where = { org: alias, cwd: emptyDir };
  const label = `${alias} (${admin ? 'admin' : 'LoggerEndUser'})`;

  const sources = await cli('sources', [], where);
  check(`${label}: sources succeeds`, sources.ok, sources);
  if (!sources.ok) return;
  const ours = sources.result.sources.find(item => item.id === source);
  check(
    `${label}: zero-config detection finds ${source} and makes it the default`,
    ours?.state === 'ready' && sources.result.defaultSourceId === source,
    sourceIds(sources.result.sources)
  );
  check(
    `${label}: hiddenFields ${admin ? 'is empty' : 'lists what describe omits'}`,
    admin ? ours?.hiddenFields.length === 0 : ours?.hiddenFields.includes('entry.details.StackTrace__c'),
    ours?.hiddenFields
  );

  const first = await cli('list', ['--limit', '3'], where);
  check(`${label}: list succeeds (no INVALID_FIELD)`, first.ok && first.result.source.id === source, first);
  if (!first.ok) return;
  const rows = first.result.rows;
  const paged = Boolean(first.result.nextCursor);
  check(
    admin ? `${label}: list returns rows and a cursor` : `${label}: list returns the logs this user can see`,
    admin ? rows.length === 3 && paged : rows.length >= 1,
    rows.length
  );
  if (paged) {
    const second = await cli('list', ['--limit', '3', '--cursor', first.result.nextCursor], where);
    const firstIds = new Set(rows.map(row => row.id));
    check(
      `${label}: the cursor continues after the last row without repeating one`,
      second.ok &&
        second.result.rows.length > 0 &&
        second.result.rows.every(row => !firstIds.has(row.id) && row.time <= rows.at(-1).time),
      second.ok ? second.result.rows.map(row => row.id) : second
    );
  }

  const errors = await cli('list', ['--min-level', 'ERROR', '--limit', '20'], where);
  check(
    `${label}: --min-level ERROR keeps only ERROR logs`,
    errors.ok && (errors.result.rows.length > 0 || !admin) && errors.result.rows.every(row => row.level === 'ERROR'),
    errors.ok ? errors.result.rows.map(row => row.level) : errors
  );
  const target = errors.ok && errors.result.rows[0] ? errors.result.rows[0] : rows[0];
  const byUser = await cli('list', ['--user', target.user, '--limit', '5'], where);
  check(
    `${label}: --user keeps only that user's logs`,
    byUser.ok && byUser.result.rows.length > 0 && byUser.result.rows.every(row => row.user === target.user),
    byUser.ok ? byUser.result.rows.map(row => row.user) : byUser
  );
  const before = await cli('list', ['--until', '2020-01-01T00:00:00Z'], where);
  check(`${label}: --until in the past returns nothing`, before.ok && before.result.rows.length === 0, before);

  const byId = await cli('get', ['--log-id', target.id, '--limit', '2'], where);
  check(
    `${label}: get --log-id returns the log, entries and a cursor`,
    byId.ok && byId.result.log.id === target.id && byId.result.entries.length > 0,
    byId
  );
  if (!byId.ok) return;
  const byTransaction = await cli('get', ['--transaction-id', target.transactionId, '--limit', '2'], where);
  check(
    `${label}: get --transaction-id finds the same log and entries as --log-id`,
    byTransaction.ok &&
      byTransaction.result.log.id === target.id &&
      JSON.stringify(byTransaction.result.entries.map(entry => entry.id)) ===
        JSON.stringify(byId.result.entries.map(entry => entry.id)),
    byTransaction.ok ? byTransaction.result.log.id : byTransaction
  );
  observed.apexLog.add(byId.result.apexLog.state);

  const entryWithDetail = byId.result.entries.find(entry => entry.presentDetails.length > 0) ?? byId.result.entries[0];
  const entry = await cli('entry', ['--entry-id', entryWithDetail.id], where);
  check(
    `${label}: entry returns every mapped detail with a state`,
    entry.ok && entry.result.details.length === 11,
    entry
  );
  if (entry.ok) {
    for (const detail of entry.result.details) observed.longValues.add(detail.state);
    observed.longValues.add(entry.result.rawPayload.state);
    const stack = entry.result.details.find(detail => detail.key === 'StackTrace__c');
    check(
      `${label}: StackTrace__c is ${admin ? 'readable' : 'hidden while presentDetails still lists it'}`,
      admin
        ? stack.state === 'value' || stack.state === 'empty'
        : stack.state === 'hidden' && entry.result.entry.presentDetails.includes('StackTrace__c'),
      stack
    );
    check(
      `${label}: a Nebula entry has no mapped payload`,
      entry.result.rawPayload.state === 'unmapped',
      entry.result.rawPayload
    );
  }

  if (admin) {
    const known = await apexLogRequestIds(alias);
    const traced = (await cli('list', ['--limit', '200'], where)).result.rows.find(row => known.has(row.requestId));
    const linked = traced && (await cli('get', ['--log-id', traced.id, '--limit', '1'], where));
    check(
      `${label}: the Apex log of a traced request is linked`,
      linked?.ok && linked.result.apexLog.state === 'linked' && linked.result.apexLog.logId.startsWith('07L'),
      linked?.ok ? linked.result.apexLog : (linked ?? 'no listed log has an ApexLog')
    );
    if (linked?.ok) observed.apexLog.add(linked.result.apexLog.state);
  } else {
    check(
      `${label}: a user who cannot read ApexLog gets unavailable, not an error and not notFound`,
      byId.result.apexLog.state === 'unavailable' && byId.result.apexLog.reason === 'noAccess',
      byId.result.apexLog
    );
  }
}

const APP_LOG_PROJECT = {
  packageDirectories: [{ path: 'force-app', default: true }],
  sourceApiVersion: '65.0',
  plugins: {
    electivus: {
      customLogs: {
        sources: [
          {
            id: 'app-log',
            label: 'App Log',
            entry: {
              object: 'App_Log__c',
              fields: {
                time: 'Logged_At__c',
                message: 'Message__c',
                level: 'Level__c',
                origin: 'Source__c',
                user: 'CreatedBy.Username',
                requestId: 'Request_Id__c'
              },
              details: ['Stack_Trace__c'],
              payload: { field: 'Payload__c', columns: ['orderId', 'http.status'] }
            }
          }
        ]
      }
    }
  }
};

const writeProject = (dir, project) =>
  fs.writeFile(path.join(dir, 'sfdx-project.json'), JSON.stringify(project, null, 2));

async function smokeAppLog({ alias }, projectDir) {
  const where = { org: alias, cwd: projectDir };
  const label = `${alias} App_Log__c`;

  const sources = await cli('sources', [], where);
  const appLog = sources.ok && sources.result.sources.find(item => item.id === 'app-log');
  check(
    `${label}: the mapped source is ready, from config, with its default payload columns`,
    appLog?.state === 'ready' &&
      appLog.origin === 'config' &&
      JSON.stringify(appLog.payload.entry?.columns) === '["orderId","http.status"]',
    appLog
  );
  check(
    `${label}: with two ready sources there is no default`,
    sources.ok && sources.result.defaultSourceId === undefined,
    sources.ok && sources.result.defaultSourceId
  );
  const ambiguous = await cli('list', [], where);
  check(
    `${label}: list without --source refuses to guess`,
    !ambiguous.ok && ambiguous.code === 'CUSTOM_LOG_SOURCE_REQUIRED',
    ambiguous
  );

  const all = await cli('list', ['--source', 'app-log', '--limit', '200'], where);
  check(
    `${label}: list reads every record`,
    all.ok && all.result.rows.length === 30 && all.result.nextCursor === null,
    all.ok ? all.result.rows.length : all
  );
  if (!all.ok) return;
  const states = new Set(all.result.rows.map(row => row.payload?.state));
  for (const state of states) observed.payloads.add(state);
  check(
    `${label}: payload states parsed, invalid and text all appear`,
    ['parsed', 'invalid', 'text'].every(state => states.has(state)),
    [...states]
  );
  const parsed = all.result.rows.find(row => row.payload?.state === 'parsed' && 'http.status' in row.payload.values);
  check(
    `${label}: a parsed payload carries flat dot paths`,
    parsed && typeof parsed.payload.values['http.status'] === 'number',
    parsed?.payload
  );
  const paths = all.result.payloadFields.map(field => field.path);
  check(
    `${label}: payloadFields lists the paths of the page`,
    ['orderId', 'http.status', 'durationMs'].every(path => paths.includes(path)),
    paths
  );

  const trimmed = await cli(
    'list',
    ['--source', 'app-log', '--limit', '200', '--payload-fields', 'orderId,http.status'],
    where
  );
  const keys = trimmed.ok
    ? trimmed.result.rows.flatMap(row => (row.payload?.state === 'parsed' ? Object.keys(row.payload.values) : []))
    : [];
  check(
    `${label}: --payload-fields trims values but payloadFields still lists every path`,
    trimmed.ok &&
      keys.length > 0 &&
      keys.every(key => key === 'orderId' || key === 'http.status') &&
      trimmed.result.payloadFields.length === paths.length,
    trimmed.ok ? { keys: [...new Set(keys)], payloadFields: trimmed.result.payloadFields.length } : trimmed
  );

  const errors = await cli('list', ['--source', 'app-log', '--min-level', 'ERROR', '--limit', '200'], where);
  const warnings = await cli('list', ['--source', 'app-log', '--min-level', 'WARN', '--limit', '200'], where);
  const levelOf = rows => new Set(rows.map(row => row.level));
  check(
    `${label}: --min-level uses the picklist spellings (WARNING counts as WARN)`,
    errors.ok &&
      warnings.ok &&
      [...levelOf(errors.result.rows)].every(level => level === 'ERROR') &&
      [...levelOf(warnings.result.rows)].every(level => level === 'WARN' || level === 'ERROR') &&
      warnings.result.rows.length >= errors.result.rows.length,
    { error: errors.ok && errors.result.rows.length, warn: warnings.ok && warnings.result.rows.length }
  );

  const get = await cli('get', ['--source', 'app-log', '--log-id', parsed.id], where);
  check(
    `${label}: get opens one record with its parsed payload and no Apex log`,
    get.ok &&
      get.result.entries.length === 1 &&
      get.result.entries[0].payload?.state === 'parsed' &&
      ['notFound', 'noRequestId'].includes(get.result.apexLog.state),
    get.ok ? get.result.apexLog : get
  );
  const entry = await cli('entry', ['--entry-id', parsed.id], where);
  if (entry.ok) {
    for (const detail of entry.result.details) observed.longValues.add(detail.state);
    observed.longValues.add(entry.result.rawPayload.state);
  }
  check(
    `${label}: entry returns the raw payload as a JSON value`,
    entry.ok && entry.result.rawPayload.state === 'value' && entry.result.rawPayload.format === 'json',
    entry.ok ? entry.result.rawPayload : entry
  );

  const page = await cli('list', ['--source', 'app-log', '--limit', '2'], where);
  await writeProject(projectDir, {
    ...APP_LOG_PROJECT,
    plugins: {
      electivus: {
        customLogs: {
          sources: [
            {
              ...APP_LOG_PROJECT.plugins.electivus.customLogs.sources[0],
              entry: { ...APP_LOG_PROJECT.plugins.electivus.customLogs.sources[0].entry, columns: ['Source__c'] }
            }
          ]
        }
      }
    }
  });
  const stale = await cli('list', ['--source', 'app-log', '--limit', '2', '--cursor', page.result.nextCursor], where);
  check(
    `${label}: a cursor is refused after the mapping is edited`,
    !stale.ok && stale.code === 'CUSTOM_LOG_INVALID_CURSOR',
    stale
  );
  await writeProject(projectDir, APP_LOG_PROJECT);
}

async function smokeEndUserWithProject({ alias, source }, projectDir) {
  const sources = await cli('sources', [], { org: alias, cwd: projectDir });
  const appLog = sources.ok && sources.result.sources.find(item => item.id === 'app-log');
  const nebula = sources.ok && sources.result.sources.find(item => item.id === source);
  check(
    `${alias}: a mapped source that is unavailable here is reported, and ${source} still loads`,
    appLog?.state === 'unavailable' && nebula?.state === 'ready',
    sources.ok ? sourceIds(sources.result.sources) : sources
  );
}

async function smoke(aliases) {
  const known = aliases.length > 0 ? HARNESS.filter(entry => aliases.includes(entry.alias)) : HARNESS;
  const unknown = aliases.filter(alias => !HARNESS.some(entry => entry.alias === alias));
  if (unknown.length > 0)
    throw new Error(
      `Unknown alias ${unknown.join(', ')}. Harness aliases: ${HARNESS.map(entry => entry.alias).join(', ')}.`
    );

  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-custom-logs-smoke-empty-'));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-custom-logs-smoke-project-'));
  await writeProject(projectDir, APP_LOG_PROJECT);
  try {
    for (const entry of known) {
      console.log(`\n# ${entry.alias}`);
      await smokeNebula(entry, emptyDir);
      if (entry.appLog) await smokeAppLog(entry, projectDir);
      else await smokeEndUserWithProject(entry, projectDir);
    }
    if (known.length === HARNESS.length) {
      console.log('\n# across the orgs');
      check(
        'entry long values were observed in all four states',
        ['value', 'empty', 'hidden', 'unmapped'].every(state => observed.longValues.has(state)),
        [...observed.longValues]
      );
      check(
        'get resolved the Apex log link as linked, notFound and unavailable',
        observed.apexLog.has('linked') && observed.apexLog.has('notFound') && observed.apexLog.has('unavailable'),
        [...observed.apexLog]
      );
    }
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  }
  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(
    JSON.stringify(
      { observed: Object.fromEntries(Object.entries(observed).map(([key, set]) => [key, [...set].sort()])), failed },
      null,
      2
    )
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.includes('--capture-fixtures')) {
  await captureFixtures();
} else {
  await smoke(args.filter(arg => !arg.startsWith('--')));
}
