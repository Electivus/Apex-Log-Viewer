const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const load = () => import(pathToFileURL(path.join(__dirname, 'events-org.mjs')).href);

function silenced(run) {
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(String(message));
  return Promise.resolve(run()).finally(() => {
    console.error = original;
  });
}

test('the alias guard accepts only alv-events', async () => {
  const { assertEventsOrg } = await load();
  assert.doesNotThrow(() => assertEventsOrg('alv-events'));
  for (const alias of [
    'alv-nebula-unlocked',
    'alv-nebula-managed-enduser',
    'ALV-EVENTS',
    'alv-events ',
    '',
    undefined
  ]) {
    assert.throws(() => assertEventsOrg(alias), /only operates on alv-events/, String(alias));
  }
});

test('every command refuses another alias before it reads anything else', async () => {
  const { parseArgs, main } = await load();
  const commands = [
    ['ensure'],
    ['publish', '--count', '5', '--transaction-id', 'T'],
    ['limits'],
    ['verify'],
    ['record', '--name', 'x', '--replay', '-2'],
    ['measure', '--object', 'ALV_Test_Backlog__e', '--replay', '-2']
  ];
  for (const command of commands) {
    assert.throws(
      () => parseArgs([...command, '--target-org', 'alv-nebula-unlocked']),
      /refused "alv-nebula-unlocked"/
    );
    assert.throws(() => parseArgs([...command, '--target-org=alv-nebula-managed']), /refused "alv-nebula-managed"/);
  }
  const code = await silenced(() => main(['limits', '--target-org', 'alv-nebula-unlocked']));
  assert.equal(code, 2);
});

test('arguments parse into typed options with defaults', async () => {
  const { parseArgs } = await load();
  assert.deepEqual(parseArgs(['limits']), { command: 'limits', alias: 'alv-events', options: {} });
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['--help']).command, 'help');

  const publish = parseArgs(['publish', '--count', '870', '--transaction-id=burst', '--level', 'mixed']);
  assert.deepEqual(publish.options, {
    level: 'mixed',
    object: 'ALV_Test_Log__e',
    count: 870,
    'transaction-id': 'burst'
  });
  assert.equal(parseArgs(['publish', '--count', '1', '--transaction-id', 'T']).options.level, 'INFO');

  assert.deepEqual(parseArgs(['ensure']).options, { 'duration-days': 30, wait: 20 });
  assert.equal(parseArgs(['ensure', '--dev-hub', 'my-hub', '--duration-days', '7']).options['dev-hub'], 'my-hub');
  assert.equal(parseArgs(['verify', '--capture-describe']).options['capture-describe'], true);
});

test('publish and measure take one of the three ALV test events', async () => {
  const { EVENT_OBJECTS, parseArgs } = await load();
  assert.deepEqual(EVENT_OBJECTS, ['ALV_Test_Log__e', 'ALV_Test_Replay__e', 'ALV_Test_Backlog__e']);
  for (const object of EVENT_OBJECTS) {
    assert.equal(
      parseArgs(['publish', '--count', '1', '--transaction-id', 'T', '--object', object]).options.object,
      object
    );
    assert.equal(parseArgs(['measure', '--object', object, '--replay', '-2']).options.object, object);
  }
  assert.throws(
    () => parseArgs(['publish', '--count', '1', '--transaction-id', 'T', '--object', 'LogEntryEvent__e']),
    /--object must be one of/
  );
  assert.throws(() => parseArgs(['measure', '--replay', '-2']), /measure needs --object/);
  assert.throws(() => parseArgs(['measure', '--object', 'ALV_Test_Backlog__e']), /measure needs --replay/);
  const measure = parseArgs(['measure', '--object', 'ALV_Test_Backlog__e', '--replay', '-2', '--max-events', '10000']);
  assert.deepEqual(measure.options, {
    object: 'ALV_Test_Backlog__e',
    replay: -2,
    'max-events': 10000,
    'quiet-ms': 8000,
    'no-event-ms': 30000,
    'max-ms': 120000
  });
});

test('record takes -2, -1 or a replay id after a space or an equals sign', async () => {
  const { parseArgs } = await load();
  const replay = value => parseArgs(['record', '--name', 'burst-870', `--replay=${value}`]).options.replay;
  assert.equal(replay('-2'), -2);
  assert.equal(replay('-1'), -1);
  assert.equal(replay('15253040'), 15253040);
  assert.equal(parseArgs(['record', '--name', 'single', '--replay', '-2']).options.replay, -2);
  assert.equal(parseArgs(['record', '--name', 'single', '--replay', '7']).options['max-events'], 1000);
  for (const bad of ['abc', '1.5', '-3', '--replay', '']) {
    assert.throws(() => parseArgs(['record', '--name', 'single', '--replay', bad]), /replay/, bad);
  }
});

test('bad arguments are usage errors that name the problem', async () => {
  const { parseArgs, UsageError } = await load();
  const rejects = (argv, pattern) =>
    assert.throws(
      () => parseArgs(argv),
      error => error instanceof UsageError && pattern.test(error.message),
      argv.join(' ')
    );
  rejects(['delete'], /unknown command "delete"/);
  rejects(['limits', '--count', '3'], /unknown flag --count for limits/);
  rejects(['limits', 'extra'], /unexpected argument "extra"/);
  rejects(['publish', '--transaction-id', 'T'], /publish needs --count/);
  rejects(['publish', '--count', '5'], /publish needs --transaction-id/);
  rejects(['publish', '--count', '0', '--transaction-id', 'T'], /--count must be an integer from 1 to 5000/);
  rejects(['publish', '--count', '5001', '--transaction-id', 'T'], /--count must be an integer from 1 to 5000/);
  rejects(['publish', '--count', '5', '--count', '6', '--transaction-id', 'T'], /--count given twice/);
  rejects(['publish', '--count', '--transaction-id', 'T'], /--count needs a value/);
  rejects(['publish', '--count'], /--count needs a value/);
  rejects(['publish', '--count', '5', '--transaction-id', 'T', '--level', 'LOUD'], /--level must be one of/);
  rejects(['publish', '--count', '5', '--transaction-id', 'a b'], /--transaction-id must be/);
  rejects(['record', '--replay', '-2'], /record needs --name/);
  rejects(['record', '--name', 'Bad Name', '--replay', '-2'], /--name must be/);
  rejects(['verify', '--capture-describe=yes'], /takes no value/);
});

test('the sanitizer removes org ids, usernames, record ids and instance hosts', async () => {
  const { sanitizeRecording, findLeaks } = await load();
  const recorded = [
    {
      batch: 0,
      data: {
        schema: 'XEgc3HqAAy-0hGAZb7nUHg',
        payload: {
          CreatedDate: '2026-10-30T20:15:00.123Z',
          CreatedById: '005xx000001AbCdEAA',
          Message__c: 'Order 801xx0000001ABCAAY of 0015g00000AbCdE failed in 00Dxx0000001gPLEAY',
          Username__c: 'jane.doe@acme-corp.com',
          Payload__c: '{"url":"https://acme.my.salesforce.com/services/data","owner":"jane.doe@acme-corp.com"}',
          Epoch_Ms__c: 1761855300123,
          Has_Stack_Trace__c: false,
          Stack_Trace__c: null
        },
        event: {
          EventUuid: '8e0c7f3a-2f9d-4a79-9f0b-6a3f5d1c2b44',
          replayId: 15253040,
          EventApiName: 'ALV_Test_Log__e'
        }
      }
    },
    {
      batch: 0,
      data: {
        schema: 'XEgc3HqAAy-0hGAZb7nUHg',
        payload: {
          CreatedDate: '2026-10-30T20:15:00.124Z',
          CreatedById: '005xx000001AbCdEAA',
          Username__c: 'synthetic.user@example.com'
        },
        event: {
          EventUuid: '0b6d3c1e-4b7a-4d4f-8e1d-2a9c7f5e3d10',
          replayId: 15253041,
          EventApiName: 'ALV_Test_Log__e'
        }
      }
    }
  ];
  const before = JSON.stringify(recorded);
  assert.notEqual(findLeaks(before).length, 0);

  const clean = sanitizeRecording(recorded);
  assert.equal(JSON.stringify(recorded), before, 'the input is not mutated');
  const text = JSON.stringify(clean);
  assert.deepEqual(findLeaks(text), []);
  for (const secret of [
    '005xx000001AbCdEAA',
    '801xx0000001ABCAAY',
    '0015g00000AbCdE',
    '00Dxx0000001gPLEAY',
    'jane.doe',
    'acme'
  ]) {
    assert.ok(!text.includes(secret), secret);
  }

  const [first, second] = clean;
  assert.equal(first.data.payload.CreatedById, second.data.payload.CreatedById, 'one id keeps one placeholder');
  assert.match(first.data.payload.CreatedById, /^005000000000\d{3}AAA$/);
  assert.equal(first.data.payload.Message__c.match(/\b[0-9a-z]{3}0{9}\d{3}(?:AAA)?\b/gi).length, 3);
  assert.equal(new Set(first.data.payload.Message__c.match(/\b[0-9a-z]{3}0{9}\d{3}(?:AAA)?\b/gi)).size, 3);
  assert.equal(first.data.payload.Username__c, 'user1@example.com');
  assert.match(first.data.payload.Payload__c, /"owner":"user1@example.com"/);
  assert.match(first.data.payload.Payload__c, /https:\/\/instance\.example\.invalid\/services\/data/);
  assert.equal(second.data.payload.Username__c, 'synthetic.user@example.com', 'reserved domains stay');
  assert.equal(first.data.schema, 'SyntheticSchema0000001');
  assert.equal(second.data.schema, first.data.schema);
});

test('the sanitizer keeps what the tests depend on and is idempotent', async () => {
  const { sanitizeRecording } = await load();
  const recorded = [
    {
      batch: 3,
      data: {
        schema: 'abcdefghijklmnopqrstuv',
        payload: {
          CreatedDate: '2026-10-30T20:15:00.123Z',
          CreatedById: '005xx000001AbCdEAA',
          Epoch_Ms__c: 1761855300123,
          Message__c: 'internationalization 1761855300123 8e0c7f3a-2f9d-4a79-9f0b-6a3f5d1c2b44',
          Level__c: 'ERROR',
          Has_Stack_Trace__c: true
        },
        event: {
          EventUuid: '8e0c7f3a-2f9d-4a79-9f0b-6a3f5d1c2b44',
          replayId: 15253040,
          EventApiName: 'ALV_Test_Log__e'
        }
      }
    }
  ];
  const once = sanitizeRecording(recorded);
  assert.equal(once[0].batch, 3);
  assert.deepEqual(once[0].data.event, recorded[0].data.event);
  assert.equal(once[0].data.payload.CreatedDate, '2026-10-30T20:15:00.123Z');
  assert.equal(once[0].data.payload.Epoch_Ms__c, 1761855300123);
  assert.equal(once[0].data.payload.Message__c, recorded[0].data.payload.Message__c);
  assert.equal(once[0].data.payload.Has_Stack_Trace__c, true);
  assert.deepEqual(sanitizeRecording(once), once);
});

test('findLeaks names each kind of org data without echoing it', async () => {
  const { findLeaks } = await load();
  const kinds = text => findLeaks(text).map(leak => leak.kind);
  assert.deepEqual(kinds('{"id":"00Dxx0000001gPLEAY"}'), ['orgId']);
  assert.deepEqual(kinds('{"id":"0015g00000AbCdE"}'), ['recordId']);
  assert.deepEqual(kinds('owner admin@acme.org'), ['username']);
  assert.deepEqual(kinds('https://acme.my.salesforce.com/x'), ['host']);
  assert.deepEqual(kinds('Bearer 00Dxx0000001gPL!AQEAQabc.def_ghi'), ['orgId', 'sessionId']);
  assert.deepEqual(kinds('force://PlatformCLI::5Aep861abc@acme.my.salesforce.com'), ['username', 'host', 'authUrl']);
  assert.deepEqual(kinds('005000000000001AAA a@example.com SyntheticSchema0000001 1761855300123'), []);
  for (const leak of findLeaks('{"id":"00Dxx0000001gPLEAY"} admin@acme.org')) {
    assert.ok(leak.value.length <= 4 + 1, leak.value);
  }
});

test('synthetic events carry the run tag, a sequence and no org data', async () => {
  const { buildSyntheticEvents, findLeaks } = await load();
  const now = Date.UTC(2026, 9, 30, 20, 15, 0);
  const events = buildSyntheticEvents({ count: 8, transactionId: 'resume', runTag: 'a1b2c3', level: 'mixed', now });
  assert.equal(events.length, 8);
  assert.deepEqual(
    events.map(event => event.Sequence__c),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(events.map(event => event.Level__c).slice(0, 5), ['DEBUG', 'INFO', 'WARN', 'ERROR', 'DEBUG']);
  assert.ok(events.every(event => event.Transaction_Id__c === 'resume-a1b2c3'));
  assert.equal(events[0].Logged_At__c, '2026-10-30T20:15:00.000Z');
  assert.equal(events[1].Epoch_Ms__c, now + 1);
  const errors = events.filter(event => event.Level__c === 'ERROR');
  assert.ok(errors.length > 0 && errors.every(event => event.Has_Stack_Trace__c && event.Stack_Trace__c));
  assert.ok(events.filter(event => event.Level__c !== 'ERROR').every(event => !('Stack_Trace__c' in event)));
  assert.deepEqual(findLeaks(JSON.stringify(events)), []);
  assert.ok(
    buildSyntheticEvents({ count: 2, transactionId: 'T', runTag: 'zzzz', level: 'WARN', now: 0 }).every(
      e => e.Level__c === 'WARN'
    )
  );
});

test('long messages are padded to the requested length and published in smaller batches', async () => {
  const { buildSyntheticEvents, parseArgs, publishBatchSize } = await load();
  const [event] = buildSyntheticEvents({
    count: 1,
    transactionId: 'T',
    runTag: 'zzzz',
    level: 'INFO',
    now: 0,
    messageChars: 90000
  });
  assert.equal(event.Message__c.length, 90000);
  assert.match(event.Message__c, /^Synthetic INFO entry 1 of 1 \(zzzz\) filler/);
  const [short] = buildSyntheticEvents({
    count: 1,
    transactionId: 'T',
    runTag: 'zzzz',
    level: 'INFO',
    now: 0,
    messageChars: 10
  });
  assert.equal(short.Message__c, 'Synthetic ');

  assert.equal(publishBatchSize(undefined), 25);
  assert.equal(publishBatchSize(100), 25);
  assert.equal(publishBatchSize(90000), 11);
  assert.equal(publishBatchSize(131072), 7);

  const parse = chars => parseArgs(['publish', '--count', '1', '--transaction-id', 'T', '--message-chars', chars]);
  assert.equal(parse('131072').options['message-chars'], 131072);
  assert.throws(() => parse('131073'), /--message-chars must be an integer from 1 to 131072/);
  assert.throws(() => parse('0'), /--message-chars must be an integer/);
});

test('verify finds triggers and flows that subscribe to the event by name, id or label', async () => {
  const { flowsReferencing, triggersReferencing } = await load();
  const names = ['ALV_Test_Log__e', '01Ixx0000000001'];
  const triggers = [
    { Name: 'ByApiName', TableEnumOrId: 'ALV_Test_Log__e' },
    { Name: 'ById', TableEnumOrId: '01Ixx0000000001' },
    { Name: 'OtherObject', TableEnumOrId: 'Account' }
  ];
  assert.deepEqual(triggersReferencing(triggers, names), ['ByApiName', 'ById']);
  assert.deepEqual(triggersReferencing([], names), []);

  const flows = [
    { ApiName: 'ByApiName', TriggerObjectOrEventId: 'ALV_Test_Log__e', TriggerObjectOrEventLabel: null },
    { ApiName: 'ByLabel', TriggerObjectOrEventId: null, TriggerObjectOrEventLabel: 'ALV Test Log' },
    { ApiName: 'Unrelated', TriggerObjectOrEventId: 'Account', TriggerObjectOrEventLabel: 'Account' }
  ];
  assert.deepEqual(flowsReferencing(flows, names, 'ALV Test Log'), ['ByApiName', 'ByLabel']);
  assert.deepEqual(flowsReferencing(flows, names, undefined), ['ByApiName']);
});

test('the committed describe fixture lists exactly the deployed fields of a non-queryable event', async () => {
  const { DESCRIBE_FIXTURE, EVENT_OBJECT, ORG_PROJECT_DIR } = await load();
  const describe = JSON.parse(fs.readFileSync(DESCRIBE_FIXTURE, 'utf8'))[EVENT_OBJECT];
  assert.equal(describe.name, EVENT_OBJECT);
  assert.equal(describe.queryable, false);
  assert.equal(describe.keyPrefix, 'e00');

  const fieldsDir = path.join(ORG_PROJECT_DIR, 'force-app/main/default/objects', EVENT_OBJECT, 'fields');
  const deployed = fs.readdirSync(fieldsDir).map(name => name.replace('.field-meta.xml', ''));
  const custom = describe.fields.map(field => field.name).filter(name => name.endsWith('__c'));
  assert.deepEqual(custom.sort(), deployed.sort());
  const standard = describe.fields.map(field => field.name).filter(name => !name.endsWith('__c'));
  assert.deepEqual(standard.sort(), ['CreatedById', 'CreatedDate', 'EventUuid', 'ReplayId']);
});

test('the committed recordings are synthetic, ordered and free of org data', async () => {
  const { FIXTURE_DIR, findLeaks, SYNTHETIC_USERNAME } = await load();
  const recordings = fs.readdirSync(FIXTURE_DIR).filter(name => name.endsWith('.events.json'));
  assert.deepEqual(recordings.sort(), ['burst-870.events.json', 'single.events.json']);

  for (const name of recordings) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    assert.deepEqual(findLeaks(text), [], name);
    const recording = JSON.parse(text);
    const replayIds = recording.map(entry => entry.data.event.replayId);
    assert.ok(
      replayIds.every((id, index) => index === 0 || id > replayIds[index - 1]),
      `${name}: replay ids increase`
    );
    assert.equal(new Set(recording.map(entry => entry.data.event.EventUuid)).size, recording.length, name);
    for (const { data } of recording) {
      assert.equal(data.event.EventApiName, 'ALV_Test_Log__e', name);
      assert.equal(data.payload.Username__c, SYNTHETIC_USERNAME, name);
      assert.match(data.payload.Transaction_Id__c, /^events-/, name);
      assert.match(data.payload.CreatedById, /^005[0-9]{9}[0-9]{3}AAA$/, `${name}: sanitized user id`);
      assert.match(data.schema, /^SyntheticSchema\d{7}$/, name);
    }
  }

  const burst = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'burst-870.events.json'), 'utf8'));
  assert.equal(burst.length, 870);
  assert.ok(
    burst.every(entry => entry.batch === 0),
    'one HTTP response, as measured for a -2 replay'
  );
  const single = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'single.events.json'), 'utf8'));
  assert.deepEqual(single[0].data, burst.at(-1).data, 'single is the last event of the burst');
});

test('the describe and recording formats stay one entry per line and round-trip', async () => {
  const { formatDescribeFixture, formatRecording, trimDescribe } = await load();
  const describe = trimDescribe({
    name: 'ALV_Test_Log__e',
    keyPrefix: 'e00',
    queryable: false,
    fields: [
      {
        name: 'ReplayId',
        label: 'Replay ID',
        type: 'string',
        referenceTo: [],
        sortable: false,
        filterable: false,
        picklistValues: [],
        extra: 1
      },
      {
        name: 'Level__c',
        label: 'Level',
        type: 'picklist',
        referenceTo: [],
        sortable: true,
        filterable: true,
        picklistValues: [{ value: 'A', active: true, label: 'x' }]
      }
    ]
  });
  assert.deepEqual(Object.keys(describe), ['name', 'keyPrefix', 'queryable', 'fields']);
  assert.ok(!('extra' in describe.fields[0]));
  assert.deepEqual(describe.fields[1].picklistValues, [{ value: 'A', active: true }]);
  const text = formatDescribeFixture({ ALV_Test_Log__e: describe });
  assert.deepEqual(JSON.parse(text), { ALV_Test_Log__e: describe });
  assert.equal(text.split('\n').filter(line => line.startsWith('      {')).length, 2);

  const events = [
    { batch: 0, data: { a: 1 } },
    { batch: 1, data: { a: 2 } }
  ];
  const recording = formatRecording(events);
  assert.deepEqual(JSON.parse(recording), events);
  assert.equal(recording.split('\n').length, events.length + 3);
});

test('the scratch definition and metadata describe a subscriber-free high-volume event', async () => {
  const { EVENTS_ORG_NAME, EVENT_OBJECT, EVENT_OBJECTS, PERMISSION_SET, SCRATCH_DEFINITION, ORG_PROJECT_DIR } =
    await load();
  const definition = JSON.parse(fs.readFileSync(SCRATCH_DEFINITION, 'utf8'));
  assert.equal(definition.orgName, EVENTS_ORG_NAME);
  assert.equal(definition.edition, 'Developer');

  const objectDir = path.join(ORG_PROJECT_DIR, 'force-app/main/default/objects', EVENT_OBJECT);
  const object = fs.readFileSync(path.join(objectDir, `${EVENT_OBJECT}.object-meta.xml`), 'utf8');
  assert.match(object, /<eventType>HighVolume<\/eventType>/);
  assert.match(object, /<publishBehavior>PublishImmediately<\/publishBehavior>/);

  const fields = fs.readdirSync(path.join(objectDir, 'fields')).map(name => name.replace('.field-meta.xml', ''));
  assert.deepEqual(fields.sort(), [
    'Epoch_Ms__c',
    'Has_Stack_Trace__c',
    'Level__c',
    'Logged_At__c',
    'Message__c',
    'Payload__c',
    'Request_Id__c',
    'Sequence__c',
    'Stack_Trace__c',
    'Transaction_Id__c',
    'Username__c'
  ]);
  const fieldXml = name => fs.readFileSync(path.join(objectDir, 'fields', `${name}.field-meta.xml`), 'utf8');
  assert.match(fieldXml('Message__c'), /<type>LongTextArea<\/type>[\s\S]*<visibleLines>/);
  assert.match(fieldXml('Message__c'), /<length>131072<\/length>/);
  assert.match(fieldXml('Logged_At__c'), /<type>DateTime<\/type>/);
  assert.match(fieldXml('Has_Stack_Trace__c'), /<type>Checkbox<\/type>/);

  const permissionSet = fs.readFileSync(
    path.join(ORG_PROJECT_DIR, 'force-app/main/default/permissionsets', `${PERMISSION_SET}.permissionset-meta.xml`),
    'utf8'
  );
  assert.match(permissionSet, /<allowRead>true<\/allowRead>/);
  for (const name of fields) {
    assert.match(permissionSet, new RegExp(`<field>${EVENT_OBJECT}\\.${name}</field>`));
  }

  for (const object of EVENT_OBJECTS.filter(object => object !== EVENT_OBJECT)) {
    const dir = path.join(ORG_PROJECT_DIR, 'force-app/main/default/objects', object);
    assert.match(fs.readFileSync(path.join(dir, `${object}.object-meta.xml`), 'utf8'), /<eventType>HighVolume</);
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'fields')).sort(),
      fs.readdirSync(path.join(objectDir, 'fields')).sort(),
      `${object} has the fields of ${EVENT_OBJECT}`
    );
    assert.match(permissionSet, new RegExp(`<object>${object}</object>`));
    for (const name of fields) {
      assert.match(permissionSet, new RegExp(`<field>${object}\\.${name}</field>`));
    }
  }

  const listed = [];
  const walk = dir =>
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else listed.push(path.relative(ORG_PROJECT_DIR, entryPath));
    });
  walk(ORG_PROJECT_DIR);
  assert.deepEqual(
    listed.filter(file => /\.(trigger|cls|flow-meta\.xml|flowDefinition-meta\.xml|workflow-meta\.xml)$/.test(file)),
    [],
    'nothing in the fixture subscribes to the event'
  );
});

test('events-org.test.js is part of the explicit test:scripts list', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  assert.match(scripts['test:scripts'], /scripts\/events-org\.test\.js/);
});
