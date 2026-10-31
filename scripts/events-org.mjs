#!/usr/bin/env node
// The one tool that touches the dedicated platform-event scratch org. It refuses every alias except
// `alv-events`, so no test and no human can publish into a harness org: publishing LogEntryEvent__e
// there persists into Log__c.
//
//   node scripts/events-org.mjs ensure  [--dev-hub <alias>] [--duration-days 30] [--wait 20]
//       Create or reuse the org from config/project-scratch-def.events.json (Dev Hub: --dev-hub or
//       $SF_DEVHUB_ALIAS; the default org and the default Dev Hub are never changed), deploy
//       test/e2e/fixtures/events-org/, assign ALV_Test_Events to the admin, create the restricted
//       user without it (alias alv-events-restricted), then run `verify`.
//   node scripts/events-org.mjs publish --count N --transaction-id T [--level L|mixed] [--run-tag R] [--message-chars C]
//                                        [--object ALV_Test_Log__e|ALV_Test_Replay__e|ALV_Test_Backlog__e]
//       Publish N synthetic events over REST in batches of 25. Transaction_Id__c is `<T>-<run tag>`, so
//       assertions that filter by it never see another run's events. --message-chars pads Message__c to C
//       characters (up to the field's 131072) for large-event scenarios. Scenarios that replay `-2` use
//       ALV_Test_Replay__e, and the 10,000-event backlog uses ALV_Test_Backlog__e, so the retained backlog
//       of ALV_Test_Log__e (what every `-2` replay of it delivers for 72 hours) stays small.
//   node scripts/events-org.mjs limits
//       Print the platform event and streaming allocations from /limits.
//   node scripts/events-org.mjs verify  [--capture-describe]
//       Exit 1 unless the org is the events org, no trigger or active flow subscribes to any ALV test event,
//       the permission set is assigned to the admin only, and the describe of ALV_Test_Log__e matches the
//       committed fixture. --capture-describe rewrites that fixture from the org first.
//   node scripts/events-org.mjs record  --name <fixture> --replay -2|-1|<id> [--max-events N]
//       Subscribe once without the core adapter and write the sanitized messages to
//       test/fixtures/customLogs/events/<fixture>.events.json for the Bayeux double.
//   node scripts/events-org.mjs measure --object O --replay -2|-1|<id> [--max-events N] [--quiet-ms M] [--no-event-ms M] [--max-ms M]
//       Subscribe once without the core adapter, write nothing, and print when the subscribe was acknowledged,
//       when each response arrived and how many events it held. The first-byte latency of a replay.
//
// Every subscription costs one delivery per event against the org's daily allocation: `record` refuses
// to start when fewer than --max-events deliveries remain. The counter in /limits lags by more than a
// minute, so run `limits` afterwards for the spend instead of trusting a reading taken at once.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const SF_BIN = process.env.ALV_SF_BIN_PATH || 'sf';

export const EVENTS_ORG_ALIAS = 'alv-events';
export const RESTRICTED_USER_ALIAS = 'alv-events-restricted';
export const EVENTS_ORG_NAME = 'ALV events';
export const EVENT_OBJECT = 'ALV_Test_Log__e';
export const REPLAY_OBJECT = 'ALV_Test_Replay__e';
export const BACKLOG_OBJECT = 'ALV_Test_Backlog__e';
export const EVENT_OBJECTS = [EVENT_OBJECT, REPLAY_OBJECT, BACKLOG_OBJECT];
export const EVENT_CHANNEL = `/event/${EVENT_OBJECT}`;
export const PERMISSION_SET = 'ALV_Test_Events';
export const SYNTHETIC_USERNAME = 'synthetic.user@example.com';

export const SCRATCH_DEFINITION = path.join(REPO_ROOT, 'config/project-scratch-def.events.json');
export const ORG_PROJECT_DIR = path.join(REPO_ROOT, 'test/e2e/fixtures/events-org');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'test/fixtures/customLogs/events');
export const DESCRIBE_FIXTURE = path.join(FIXTURE_DIR, 'describe-alv-test-log.json');

const PUBLISH_BATCH = 25;
const MESSAGE_MAX_CHARS = 131072;
const PUBLISH_BATCH_CHARS = 1_000_000;
const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];
const MIXED_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

export function assertEventsOrg(alias) {
  if (alias !== EVENTS_ORG_ALIAS) {
    throw new Error(`events-org.mjs only operates on ${EVENTS_ORG_ALIAS}; refused ${JSON.stringify(alias)}`);
  }
}

export class UsageError extends Error {}

const integer = (min, max) => (raw, flag) => {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`--${flag} must be an integer from ${min} to ${max}; got ${JSON.stringify(raw)}`);
  }
  return value;
};

const matching = (pattern, hint) => (raw, flag) => {
  if (!pattern.test(raw)) throw new UsageError(`--${flag} must be ${hint}; got ${JSON.stringify(raw)}`);
  return raw;
};

const oneOf = values => (raw, flag) => {
  if (!values.includes(raw))
    throw new UsageError(`--${flag} must be one of ${values.join(', ')}; got ${JSON.stringify(raw)}`);
  return raw;
};

const replayId = (raw, flag) => {
  if (raw === '-2' || raw === '-1') return Number(raw);
  return integer(0, Number.MAX_SAFE_INTEGER)(raw, flag);
};

const aliasText = matching(/^[A-Za-z0-9._-]{1,64}$/, 'an org alias');
const BOOLEAN = Symbol('boolean');

const COMMANDS = {
  ensure: {
    flags: {
      'target-org': aliasText,
      'dev-hub': aliasText,
      'duration-days': integer(1, 30),
      wait: integer(1, 60)
    },
    required: [],
    defaults: { 'duration-days': 30, wait: 20 }
  },
  publish: {
    flags: {
      'target-org': aliasText,
      count: integer(1, 5000),
      'transaction-id': matching(/^[A-Za-z0-9._-]{1,40}$/, 'letters, digits, dots, underscores or dashes (1-40)'),
      level: oneOf([...LEVELS, 'mixed']),
      'run-tag': matching(/^[A-Za-z0-9]{4,12}$/, 'letters and digits (4-12)'),
      'message-chars': integer(1, MESSAGE_MAX_CHARS),
      object: oneOf(EVENT_OBJECTS)
    },
    required: ['count', 'transaction-id'],
    defaults: { level: 'INFO', object: EVENT_OBJECT }
  },
  limits: { flags: { 'target-org': aliasText }, required: [], defaults: {} },
  verify: { flags: { 'target-org': aliasText, 'capture-describe': BOOLEAN }, required: [], defaults: {} },
  record: {
    flags: {
      'target-org': aliasText,
      name: matching(/^[a-z0-9][a-z0-9-]{0,40}$/, 'a lower-case fixture name such as burst-870'),
      replay: replayId,
      'max-events': integer(1, 5000),
      'quiet-ms': integer(500, 120000),
      'no-event-ms': integer(1000, 300000),
      'max-ms': integer(1000, 600000)
    },
    required: ['name', 'replay'],
    defaults: { 'max-events': 1000, 'quiet-ms': 8000, 'no-event-ms': 30000, 'max-ms': 120000 }
  },
  measure: {
    flags: {
      'target-org': aliasText,
      object: oneOf(EVENT_OBJECTS),
      replay: replayId,
      'max-events': integer(1, 50000),
      'quiet-ms': integer(500, 120000),
      'no-event-ms': integer(1000, 300000),
      'max-ms': integer(1000, 1800000)
    },
    required: ['object', 'replay'],
    defaults: { 'max-events': 1000, 'quiet-ms': 8000, 'no-event-ms': 30000, 'max-ms': 120000 }
  }
};

export function usage() {
  return `Usage: node scripts/events-org.mjs <${Object.keys(COMMANDS).join('|')}> [flags]\nThe org alias is always ${EVENTS_ORG_ALIAS}; see the header of this file for each command's flags.`;
}

/** Returns `{ command, alias, options }`, or throws `UsageError`/`Error` (the alias guard) before any org is touched. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h')
    return { command: 'help', alias: EVENTS_ORG_ALIAS, options: {} };
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command ${JSON.stringify(command)}`);

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(token)}`);
    const equals = token.indexOf('=');
    const flag = token.slice(2, equals === -1 ? undefined : equals);
    const parse = spec.flags[flag];
    if (!parse) throw new UsageError(`unknown flag --${flag} for ${command}`);
    if (flag in options) throw new UsageError(`--${flag} given twice`);
    if (parse === BOOLEAN) {
      if (equals !== -1) throw new UsageError(`--${flag} takes no value`);
      options[flag] = true;
      continue;
    }
    // `-2` is a value, not a flag: only a `--` prefix starts a flag.
    const raw = equals === -1 ? rest[(index += 1)] : token.slice(equals + 1);
    if (raw === undefined || raw.startsWith('--')) throw new UsageError(`--${flag} needs a value`);
    options[flag] = parse(raw, flag);
  }

  for (const flag of spec.required) {
    if (!(flag in options)) throw new UsageError(`${command} needs --${flag}`);
  }
  const alias = options['target-org'] ?? EVENTS_ORG_ALIAS;
  assertEventsOrg(alias);
  return { command, alias, options: { ...spec.defaults, ...options } };
}

/** Bodies for /composite/sobjects. Every value is invented here; nothing is read from an org. */
export function buildSyntheticEvents({ count, transactionId, runTag, level, now, messageChars }) {
  const transaction = `${transactionId}-${runTag}`;
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const entryLevel = level === 'mixed' ? MIXED_LEVELS[index % MIXED_LEVELS.length] : level;
    const failing = entryLevel === 'ERROR';
    const loggedAt = now + index;
    const message = `Synthetic ${entryLevel} entry ${sequence} of ${count} (${runTag})`;
    return {
      Message__c: messageChars === undefined ? message : message.padEnd(messageChars, ' filler').slice(0, messageChars),
      Level__c: entryLevel,
      Logged_At__c: new Date(loggedAt).toISOString(),
      Epoch_Ms__c: loggedAt,
      Transaction_Id__c: transaction,
      Sequence__c: sequence,
      Username__c: SYNTHETIC_USERNAME,
      Request_Id__c: `${runTag}-request`,
      Payload__c: JSON.stringify({ run: runTag, sequence, http: { status: failing ? 500 : 200 } }),
      ...(failing ? { Stack_Trace__c: `Class.Synthetic.run: line ${sequence}, column 1` } : {}),
      Has_Stack_Trace__c: failing
    };
  });
}

// Sanitizer: nothing from an org may reach a committed fixture

// 15 or 18 characters with a digit and a letter: a Salesforce id. Placeholders keep the key prefix.
const ID_CANDIDATE = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g;
const PLACEHOLDER_ID = /^[A-Za-z0-9]{3}0{9}\d{3}(?:AAA)?$/;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const RESERVED_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.invalid']);
const SALESFORCE_HOST = /\b(?:[A-Za-z0-9-]+\.)+(?:salesforce|force|salesforce-setup)\.com\b/gi;
const SESSION_ID = /\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?![A-Za-z0-9._-]+/;
const AUTH_URL = /force:\/\/[^\s"']+/;

const maskedFirst = value => `${value.slice(0, 3)}…`;
const placeholderOf = (id, number) =>
  `${id.slice(0, 3)}${'0'.repeat(9)}${String(number).padStart(3, '0')}${id.length === 18 ? 'AAA' : ''}`;

function sanitizeString(value, state) {
  return value
    .replace(EMAIL, (address, domain) => {
      if (RESERVED_DOMAINS.has(domain.toLowerCase())) return address;
      if (!state.emails.has(address)) state.emails.set(address, `user${state.emails.size + 1}@example.com`);
      return state.emails.get(address);
    })
    .replace(SALESFORCE_HOST, 'instance.example.invalid')
    .replace(ID_CANDIDATE, id => {
      if (PLACEHOLDER_ID.test(id)) return id;
      if (!state.ids.has(id)) state.ids.set(id, placeholderOf(id, state.ids.size + 1));
      return state.ids.get(id);
    });
}

function sanitizeValue(value, state) {
  if (typeof value === 'string') return sanitizeString(value, state);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, state));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, state)]));
  }
  return value;
}

/**
 * `recorded` is `[{ batch, data }]` as received. Org ids, record ids, usernames outside the reserved
 * example domains and instance hosts are replaced by stable placeholders; replay ids, uuids and
 * timestamps stay because the tests depend on their shape and order.
 */
export function sanitizeRecording(recorded) {
  const state = { ids: new Map(), emails: new Map() };
  const schemas = new Map();
  return recorded.map(({ batch, data }) => {
    const clean = sanitizeValue(data, state);
    if (typeof data.schema === 'string') {
      if (!schemas.has(data.schema)) {
        schemas.set(data.schema, `SyntheticSchema${String(schemas.size + 1).padStart(7, '0')}`);
      }
      clean.schema = schemas.get(data.schema);
    }
    return { batch, data: clean };
  });
}

/** What would still identify an org in `text`. Empty means the text is safe to commit. */
export function findLeaks(text) {
  const leaks = [];
  for (const [id] of text.matchAll(ID_CANDIDATE)) {
    if (!PLACEHOLDER_ID.test(id))
      leaks.push({ kind: id.startsWith('00D') ? 'orgId' : 'recordId', value: maskedFirst(id) });
  }
  for (const [address, domain] of text.matchAll(EMAIL)) {
    if (!RESERVED_DOMAINS.has(domain.toLowerCase())) leaks.push({ kind: 'username', value: maskedFirst(address) });
  }
  for (const [host] of text.matchAll(SALESFORCE_HOST)) leaks.push({ kind: 'host', value: maskedFirst(host) });
  if (SESSION_ID.test(text)) leaks.push({ kind: 'sessionId', value: '00D…' });
  if (AUTH_URL.test(text)) leaks.push({ kind: 'authUrl', value: 'force://…' });
  return leaks;
}

function assertNoLeaks(text, what) {
  const leaks = findLeaks(text);
  if (leaks.length) {
    const summary = leaks.map(leak => `${leak.kind} ${leak.value}`).join(', ');
    throw new Error(`${what} still contains org data (${summary}); refusing to write it.`);
  }
}

/** The part of describe that core reads, plus `queryable`, which tells a platform event from a record. */
export function trimDescribe(describe) {
  return {
    name: describe.name,
    keyPrefix: describe.keyPrefix,
    queryable: describe.queryable,
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

/** One field per line, as the other describe fixtures: a refreshed fixture reviews as a diff of fields. */
export function formatDescribeFixture(describes) {
  const objects = Object.entries(describes).map(([name, describe]) => {
    const fields = describe.fields.map(field => `      ${JSON.stringify(field)}`).join(',\n');
    const head = `"name": ${JSON.stringify(describe.name)}, "keyPrefix": ${JSON.stringify(describe.keyPrefix)}, "queryable": ${JSON.stringify(describe.queryable)}`;
    return `  ${JSON.stringify(name)}: {\n    ${head},\n    "fields": [\n${fields}\n    ]\n  }`;
  });
  return `{\n${objects.join(',\n')}\n}\n`;
}

/** One event per line, so a 870-event recording stays reviewable and diffable. */
export function formatRecording(events) {
  return `[\n${events.map(event => `  ${JSON.stringify(event)}`).join(',\n')}\n]\n`;
}

async function sfJson(args, { cwd = REPO_ROOT, timeoutMs = 10 * 60 * 1000 } = {}) {
  try {
    const { stdout } = await execFileAsync(SF_BIN, [...args, '--json'], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024
    });
    return JSON.parse(stdout).result;
  } catch (error) {
    let detail;
    try {
      detail = JSON.parse(error.stdout);
    } catch {
      detail = undefined;
    }
    const problems = [detail?.result?.details?.componentFailures ?? []]
      .flat()
      .map(component => `${component.fullName}: ${component.problem}`);
    const reason = problems.length > 0 ? problems.join('; ') : (detail?.message ?? error.message);
    const failure = new Error(`sf ${args.join(' ')} failed: ${reason}`);
    failure.sfName = detail?.name;
    throw failure;
  }
}

async function displayOrg(alias) {
  try {
    return await sfJson(['org', 'display', '--target-org', alias]);
  } catch (error) {
    if (error.sfName === 'NamedOrgNotFoundError' || error.sfName === 'NoAuthFoundError') return undefined;
    throw error;
  }
}

const isExpired = org => Boolean(org.expirationDate) && Date.parse(`${org.expirationDate}T23:59:59Z`) < Date.now();

async function connect(alias) {
  assertEventsOrg(alias);
  const { Org } = createRequire(path.join(REPO_ROOT, 'packages/core/package.json'))('@salesforce/core');
  const org = await Org.create({ aliasOrUsername: alias });
  const connection = org.getConnection();
  connection.setApiVersion(await connection.retrieveMaxApiVersion());
  const [organization] = (await connection.query('SELECT Name FROM Organization')).records;
  if (organization?.Name !== EVENTS_ORG_NAME) {
    throw new Error(
      `${alias} is not the events org (organization name is not ${JSON.stringify(EVENTS_ORG_NAME)}); refusing to continue.`
    );
  }
  return connection;
}

const soql = value => String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");

async function readLimits(connection) {
  const all = await connection.request('/limits');
  const interesting = Object.entries(all).filter(([name]) => /PlatformEvent|Streaming|EventBus/i.test(name));
  return Object.fromEntries(interesting.map(([name, value]) => [name, { remaining: value.Remaining, max: value.Max }]));
}

async function limits(alias) {
  const connection = await connect(alias);
  console.log(JSON.stringify({ alias, limits: await readLimits(connection) }, null, 2));
}

/** 25 events per request, fewer when long messages would push the body past about 1 MB. */
export function publishBatchSize(messageChars) {
  if (messageChars === undefined) return PUBLISH_BATCH;
  return Math.max(1, Math.min(PUBLISH_BATCH, Math.floor(PUBLISH_BATCH_CHARS / messageChars)));
}

async function publish(alias, options) {
  const connection = await connect(alias);
  const runTag = options['run-tag'] ?? randomBytes(3).toString('hex');
  const events = buildSyntheticEvents({
    count: options.count,
    transactionId: options['transaction-id'],
    runTag,
    level: options.level,
    now: Date.now(),
    messageChars: options['message-chars']
  });
  const batchSize = publishBatchSize(options['message-chars']);
  const url = `/services/data/v${connection.getApiVersion()}/composite/sobjects`;
  for (let start = 0; start < events.length; start += batchSize) {
    const records = events
      .slice(start, start + batchSize)
      .map(event => ({ attributes: { type: options.object }, ...event }));
    const results = await connection.request({
      method: 'POST',
      url,
      body: JSON.stringify({ allOrNone: true, records }),
      headers: { 'Content-Type': 'application/json' }
    });
    const failed = results.filter(result => !result.success);
    if (failed.length) {
      const codes = [...new Set(failed.flatMap(result => (result.errors ?? []).map(error => error.statusCode)))];
      throw new Error(
        `publish failed for ${failed.length} of ${records.length} events at offset ${start}: ${codes.join(', ')}`
      );
    }
  }
  console.log(
    JSON.stringify({
      alias,
      object: options.object,
      published: events.length,
      runTag,
      transactionId: `${options['transaction-id']}-${runTag}`
    })
  );
}

/** Triggers whose table is the event, by API name or by entity id. */
export function triggersReferencing(triggers, entityNames) {
  return triggers.filter(trigger => entityNames.includes(trigger.TableEnumOrId)).map(trigger => trigger.Name);
}

/** Active flows or processes started by the event. */
export function flowsReferencing(flows, entityNames, entityLabel) {
  return flows
    .filter(
      flow =>
        entityNames.includes(flow.TriggerObjectOrEventId) ||
        (entityLabel !== undefined && flow.TriggerObjectOrEventLabel === entityLabel)
    )
    .map(flow => flow.ApiName);
}

async function readCommittedDescribe() {
  try {
    return JSON.parse(await fs.readFile(DESCRIBE_FIXTURE, 'utf8'))[EVENT_OBJECT];
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function verify(alias, options) {
  const connection = await connect(alias);
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`
    );
  };

  const describe = trimDescribe(await connection.describe(EVENT_OBJECT));
  if (options['capture-describe']) {
    const text = formatDescribeFixture({ [EVENT_OBJECT]: describe });
    assertNoLeaks(text, 'The describe output');
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await fs.writeFile(DESCRIBE_FIXTURE, text);
    console.log(`wrote ${path.relative(REPO_ROOT, DESCRIBE_FIXTURE)} (${describe.fields.length} fields)`);
  }
  const committed = await readCommittedDescribe();
  check(
    'the describe matches the committed fixture',
    committed !== undefined && JSON.stringify(committed) === JSON.stringify(describe),
    committed === undefined
      ? 'fixture missing: run verify --capture-describe'
      : 'fixture differs: run verify --capture-describe'
  );

  const triggers = (await connection.tooling.query('SELECT Name, TableEnumOrId FROM ApexTrigger')).records;
  const flows = (
    await connection.query(
      'SELECT ApiName, TriggerObjectOrEventId, TriggerObjectOrEventLabel FROM FlowDefinitionView WHERE IsActive = true'
    )
  ).records;
  for (const object of EVENT_OBJECTS) {
    const objectDescribe = object === EVENT_OBJECT ? describe : trimDescribe(await connection.describe(object));
    check(
      `${object} is a platform event (not queryable, key prefix e0N)`,
      !objectDescribe.queryable && /^e\d\d$/.test(objectDescribe.keyPrefix),
      { queryable: objectDescribe.queryable, keyPrefix: objectDescribe.keyPrefix }
    );
    const [entity] = (
      await connection.tooling.query(
        `SELECT DurableId, Label FROM EntityDefinition WHERE QualifiedApiName = '${object}'`
      )
    ).records;
    const entityNames = [object, entity?.DurableId].filter(Boolean);
    check(`no Apex trigger subscribes to ${object}`, triggersReferencing(triggers, entityNames).length === 0, {
      triggers: triggersReferencing(triggers, entityNames)
    });
    check(
      `no active flow or process starts from ${object}`,
      flowsReferencing(flows, entityNames, entity?.Label).length === 0,
      { flows: flowsReferencing(flows, entityNames, entity?.Label) }
    );
  }

  const permissionSet = (await connection.query(`SELECT Id FROM PermissionSet WHERE Name = '${PERMISSION_SET}'`))
    .records;
  check(`permission set ${PERMISSION_SET} exists`, permissionSet.length === 1);
  const assignedTo = async username =>
    (
      await connection.query(
        `SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '${PERMISSION_SET}' AND Assignee.Username = '${soql(username)}'`
      )
    ).records.length > 0;
  check('the admin has the permission set', await assignedTo(connection.getUsername()));

  const restricted = await displayOrg(RESTRICTED_USER_ALIAS);
  check(`the restricted user ${RESTRICTED_USER_ALIAS} exists`, restricted !== undefined);
  if (restricted) check('the restricted user lacks the permission set', !(await assignedTo(restricted.username)));

  if (results.some(result => !result.ok)) throw new Error('verify failed');
}

async function ensure(alias, options) {
  const devHub = options['dev-hub'] ?? process.env.SF_DEVHUB_ALIAS;
  if (!devHub) throw new UsageError('ensure needs --dev-hub or SF_DEVHUB_ALIAS');

  let org = await displayOrg(alias);
  if (org && isExpired(org)) {
    console.log(`${alias} expired on ${org.expirationDate}; removing its local authorization.`);
    await sfJson(['org', 'logout', '--target-org', alias, '--no-prompt']);
    org = undefined;
  }
  const created = org === undefined;
  if (created) {
    console.log(`creating ${alias} from ${path.relative(REPO_ROOT, SCRATCH_DEFINITION)} (Dev Hub ${devHub})`);
    await sfJson(
      [
        'org',
        'create',
        'scratch',
        '--target-dev-hub',
        devHub,
        '--alias',
        alias,
        '--definition-file',
        SCRATCH_DEFINITION,
        '--duration-days',
        String(options['duration-days']),
        '--wait',
        String(options.wait),
        '--no-track-source'
      ],
      { cwd: ORG_PROJECT_DIR, timeoutMs: (options.wait + 5) * 60 * 1000 }
    );
  }

  await sfJson(['project', 'deploy', 'start', '--source-dir', 'force-app', '--target-org', alias, '--wait', '20'], {
    cwd: ORG_PROJECT_DIR,
    timeoutMs: 25 * 60 * 1000
  });

  const connection = await connect(alias);
  const assigned = await connection.query(
    `SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '${PERMISSION_SET}' AND Assignee.Username = '${soql(connection.getUsername())}'`
  );
  if (assigned.records.length === 0) {
    await sfJson(['org', 'assign', 'permset', '--name', PERMISSION_SET, '--target-org', alias]);
  }

  if ((await displayOrg(RESTRICTED_USER_ALIAS)) === undefined) {
    await sfJson([
      'org',
      'create',
      'user',
      '--target-org',
      alias,
      '--definition-file',
      path.join(ORG_PROJECT_DIR, 'restricted-user.json'),
      '--set-alias',
      RESTRICTED_USER_ALIAS
    ]);
  }

  const refreshed = await displayOrg(alias);
  console.log(JSON.stringify({ alias, created, expirationDate: refreshed?.expirationDate }));
  await verify(alias, {});
}

/** A plain Faye extension: the same `ext.replay` the core adapter sends, with no policy around it. */
function replayExtension(channel, replay) {
  return {
    outgoing(message, callback) {
      if (message.channel === '/meta/subscribe' && message.subscription === channel) {
        message.ext = { ...message.ext, replay: { [channel]: replay } };
      }
      callback(message);
    }
  };
}

/** `disconnect()` does nothing before the handshake finishes (measured), so defer it until then. */
function disconnectClient(client) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 15000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const pending = client.disconnect();
    if (pending === undefined) {
      client.callback(() => {
        const again = client.disconnect();
        if (again && typeof again.then === 'function') again.then(done, done);
        else done();
      });
    } else {
      pending.then(done, done);
    }
  });
}

/**
 * One plain Faye subscription, stopped by the first limit it meets. Faye hands over a whole HTTP response
 * in one synchronous loop, so a response is one microtask turn, and `atMs` is when it arrived.
 */
async function collect(connection, { channel, replay, maxEvents, quietMs, noEventMs, maxMs }) {
  const client = connection.streaming.createClient([replayExtension(channel, replay)]);
  const received = [];
  const arrivals = [];
  let batch = -1;
  let batchOpen = false;
  let lastEventAt = 0;
  const startedAt = Date.now();
  let subscribeError;
  let acknowledgedAt;

  const subscription = client.subscribe(channel, data => {
    if (!batchOpen) {
      batchOpen = true;
      batch += 1;
      arrivals.push({ batch, atMs: Date.now() - startedAt });
      queueMicrotask(() => {
        batchOpen = false;
      });
    }
    received.push({ batch, data });
    lastEventAt = Date.now();
  });
  subscription.callback(() => {
    acknowledgedAt = Date.now();
  });
  subscription.errback(error => {
    subscribeError = String(error?.message ?? error);
  });

  const stopReason = await new Promise(resolve => {
    const ticker = setInterval(() => {
      const now = Date.now();
      let reason;
      if (subscribeError) reason = 'subscribeError';
      else if (received.length >= maxEvents) reason = 'maxEvents';
      else if (received.length > 0 && now - lastEventAt >= quietMs) reason = 'quiet';
      else if (received.length === 0 && acknowledgedAt && now - acknowledgedAt >= noEventMs) reason = 'noEvent';
      else if (now - startedAt >= maxMs) reason = 'maxTime';
      if (reason) {
        clearInterval(ticker);
        resolve(reason);
      }
    }, 50);
  });
  subscription.cancel();
  await disconnectClient(client);
  return {
    received,
    arrivals,
    stopReason,
    subscribeError,
    ackMs: acknowledgedAt === undefined ? undefined : acknowledgedAt - startedAt,
    lastEventMs: received.length === 0 ? undefined : lastEventAt - startedAt
  };
}

async function deliveriesLeft(connection, maxEvents) {
  const before = (await readLimits(connection)).DailyDeliveredPlatformEvents;
  if (!before || before.remaining < maxEvents) {
    throw new Error(
      `DailyDeliveredPlatformEvents has ${before?.remaining ?? 'unknown'} deliveries left; --max-events is ${maxEvents}.`
    );
  }
  return before;
}

const collectOptions = options => ({
  replay: options.replay,
  maxEvents: options['max-events'],
  quietMs: options['quiet-ms'],
  noEventMs: options['no-event-ms'],
  maxMs: options['max-ms']
});

const batchSummary = (arrivals, received) =>
  arrivals.map(arrival => ({
    batch: arrival.batch,
    events: received.filter(entry => entry.batch === arrival.batch).length,
    atMs: arrival.atMs
  }));

async function record(alias, options) {
  const connection = await connect(alias);
  const before = await deliveriesLeft(connection, options['max-events']);
  const { received, arrivals, stopReason, subscribeError } = await collect(connection, {
    channel: EVENT_CHANNEL,
    ...collectOptions(options)
  });

  if (subscribeError) throw new Error(`subscribe was rejected: ${subscribeError}`);
  if (received.length === 0) throw new Error(`no event arrived (stopped: ${stopReason}); nothing written.`);

  const recording = sanitizeRecording(received);
  const text = formatRecording(recording);
  assertNoLeaks(text, `The ${options.name} recording`);
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${options.name}.events.json`);
  await fs.writeFile(file, text);

  const replayIds = received.map(entry => entry.data.event.replayId);
  console.log(
    JSON.stringify({
      file: path.relative(REPO_ROOT, file),
      stopped: stopReason,
      events: received.length,
      batches: batchSummary(arrivals, received),
      replayIds: { first: replayIds[0], last: replayIds.at(-1) },
      bytes: Buffer.byteLength(text),
      deliveries: { before: before.remaining, max: before.max }
    })
  );
}

async function measure(alias, options) {
  const connection = await connect(alias);
  const before = await deliveriesLeft(connection, options['max-events']);
  const started = new Date();
  const { received, arrivals, stopReason, subscribeError, ackMs, lastEventMs } = await collect(connection, {
    channel: `/event/${options.object}`,
    ...collectOptions(options)
  });
  if (subscribeError) throw new Error(`subscribe was rejected: ${subscribeError}`);
  const batches = batchSummary(arrivals, received);
  const replayIds = received.map(entry => entry.data.event.replayId);
  console.log(
    JSON.stringify({
      object: options.object,
      replay: options.replay,
      startedAt: started.toISOString(),
      stopped: stopReason,
      events: received.length,
      ackMs,
      firstEventMs: arrivals[0]?.atMs,
      lastEventMs,
      responses: batches.length,
      firstResponses: batches.slice(0, 5),
      largestResponse: batches.reduce((most, entry) => Math.max(most, entry.events), 0),
      replayIds: { first: replayIds[0], last: replayIds.at(-1) },
      deliveries: { before: before.remaining, max: before.max }
    })
  );
}

const HANDLERS = { ensure, publish, limits, verify, record, measure };

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    if (error instanceof UsageError) console.error(usage());
    return 2;
  }
  if (parsed.command === 'help') {
    console.log(usage());
    return 0;
  }
  try {
    await HANDLERS[parsed.command](parsed.alias, parsed.options);
    return 0;
  } catch (error) {
    console.error(error instanceof UsageError ? `${error.message}\n${usage()}` : error.message);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}
