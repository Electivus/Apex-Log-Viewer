import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import proxyquire from 'proxyquire';

import type { SourceOrg } from '@alv/core';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

/** A token this extension received from `sf` earlier and holds in memory. */
const HELD_TOKEN = 'held-token-1f2e3d4c5b6a';
// Fake values, joined at run time so that secret scanners do not take the source for real tokens.
/** Text shaped like a Salesforce access token, which the extension never received. */
const SHAPED_TOKEN = ['00D000000000001', 'AQ4AQFakeTokenForRedactionTests.0123456789'].join('!');
/** Shaped like a Salesforce refresh token. */
const SHAPED_REFRESH = ['5Aep8', '61FakeRefreshTokenForRedactionTests0123456789'].join('');

const ORG: SourceOrg = {
  username: 'dev@example.com',
  instanceUrl: 'https://dev.my.salesforce.com',
  orgId: '00D000000000001AAA'
};

type Exit = { code: number; stdout?: string; stderr?: string };

/**
 * The real `exec.ts` and `sfCliAuth.ts` over a scripted `sf` process: only the spawn, the logger,
 * telemetry and localization are replaced. Every line sent to the trace channel is kept.
 */
function load(answer: (args: string[]) => Exit) {
  const traced: string[] = [];
  const capture = (...parts: unknown[]) => {
    traced.push(parts.map(part => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part))).join(' '));
  };
  const exec = proxyquireStrict('../../host/salesforce/exec', {
    'cross-spawn': (_file: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: any; stderr: any; kill: () => void };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.kill = () => undefined;
      const exit = answer(args);
      process.nextTick(() => {
        if (exit.stdout) child.stdout.emit('data', exit.stdout);
        if (exit.stderr) child.stderr.emit('data', exit.stderr);
        child.emit('close', exit.code, null);
      });
      return child;
    },
    '../utils/logger': { logTrace: capture, logWarn: capture, logInfo: capture, logError: capture },
    '../utils/localize': {
      localize: (_key: string, fallback: string, ...args: unknown[]) =>
        fallback.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    },
    '../../shared/telemetry': { safeSendEvent: () => undefined, safeSendException: () => undefined }
  });
  const module = proxyquireStrict('../../host/salesforce/sfCliAuth', {
    './exec': exec,
    './path': { getLoginShellEnv: async () => ({ PATH: '/usr/bin' }) },
    './proxy': { readProxySettings: () => ({}) },
    '../utils/localize': {
      localize: (_key: string, fallback: string, ...args: unknown[]) =>
        fallback.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    }
  }) as typeof import('../../host/salesforce/sfCliAuth');
  return { module, source: module.createSfCliAuthSource({ projectDir: () => undefined }), traced };
}

/** The extension's core client, with the real core, over the same scripted `sf`. */
function loadClient(answer: (args: string[]) => Exit) {
  const { module, traced } = load(answer);
  const { CoreClient } = proxyquireStrict('../../runtime/runtimeClient', {
    '../host/salesforce/sfCliAuth': module,
    '../host/utils/workspace': { getWorkspaceRoot: () => undefined },
    '../shared/telemetry': { safeSendEvent: () => undefined },
    '../shared/telemetryErrorCodes': { getTelemetryErrorCode: () => 'TEST' }
  }) as typeof import('../../runtime/runtimeClient');
  return { client: new CoreClient(), traced };
}

const ok = (result: unknown): Exit => ({ code: 0, stdout: JSON.stringify({ status: 0, result }) });

const isCommand = (args: string[], command: string) => args.join(' ').startsWith(command);

/** Every string an error carries to a caller, a notification or a log line, its cause included. */
function textOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const value = current as {
      message?: unknown;
      stack?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      cause?: unknown;
    };
    for (const part of [value.message, value.stack, value.stdout, value.stderr]) {
      if (typeof part === 'string') parts.push(part);
    }
    current = value.cause;
  }
  return parts.join('\n');
}

const secrets = [HELD_TOKEN, SHAPED_TOKEN, SHAPED_REFRESH];

const ESC = '\u001b';

/** Where a failing `sf` prints `body`: in its JSON error, on stderr, or on a warning line before the JSON. */
type Place = 'json' | 'stderr' | 'outer';
const PLACES: readonly Place[] = ['json', 'stderr', 'outer'];

function failingWith(place: Place, body: string): Exit {
  if (place === 'json') return { code: 1, stdout: JSON.stringify({ status: 1, name: 'SfError', message: body }) };
  if (place === 'stderr') return { code: 1, stderr: `${body}\n` };
  return { code: 1, stdout: `WARN ${body}\n${JSON.stringify({ status: 1, message: 'test error' })}` };
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => assert.fail('the call should fail'),
    (rejection: unknown) => rejection
  );
}

/** Every string a caller or the trace receives from a failing `listOrgs` whose `sf` prints `body` at `place`. */
async function shownFor(place: Place, body: string): Promise<{ shown: string; trace: string }> {
  const { source, traced } = load(() => failingWith(place, body));
  const shown = textOf(await rejectionOf(source.listOrgs()));
  return { shown, trace: traced.join('\n') };
}

suite('sf CLI output that reaches errors and the trace channel', () => {
  const failures: Array<{ name: string; failure: Exit }> = [
    {
      name: 'a JSON error message',
      failure: {
        code: 1,
        stdout: JSON.stringify({
          status: 1,
          name: 'SfError',
          message: `Request failed with ${HELD_TOKEN}, ${SHAPED_TOKEN} and ${SHAPED_REFRESH}`
        })
      }
    },
    {
      name: 'stderr',
      failure: { code: 1, stderr: `Warning: request failed with ${HELD_TOKEN} ${SHAPED_TOKEN} ${SHAPED_REFRESH}\n` }
    }
  ];

  for (const { name, failure } of failures) {
    test(`a token in ${name} of a failing sf reaches neither the error nor the trace`, async () => {
      const { source, traced } = load(args =>
        isCommand(args, 'org auth show-access-token')
          ? { code: 0, stdout: JSON.stringify({ status: 0, result: { accessToken: HELD_TOKEN } }) }
          : failure
      );
      assert.equal((await source.session(ORG, 'first-use')).accessToken, HELD_TOKEN);

      const error = await source.listOrgs().then(
        () => assert.fail('listOrgs should fail'),
        (rejection: unknown) => rejection
      );

      const shown = textOf(error);
      assert.match(shown, /request failed with/i, 'the error still says what sf reported');
      for (const secret of secrets) {
        assert.ok(!shown.includes(secret), `the error carries no ${secret.slice(0, 8)}…`);
        assert.ok(!traced.join('\n').includes(secret), `the trace carries no ${secret.slice(0, 8)}…`);
      }
      assert.match(shown, /\[redacted\]/, 'the error marks where a token was');
    });
  }

  test('a session id that color codes surround or split reaches neither the error nor the trace', async () => {
    // A session id the extension does not hold, shaped like one: what sf prints, colored as FORCE_COLOR makes it.
    const session = ['00D000000000001AAA', 'FAKEColoredSession0123456789'].join('!');
    const colored = [`${ESC}[31m${session}${ESC}[39m`, `${session.slice(0, 10)}${ESC}[1m${session.slice(10)}`];
    for (const place of PLACES) {
      for (const token of colored) {
        const { shown, trace } = await shownFor(place, `Request failed for ${token}`);

        assert.match(shown, /request failed for/i, `${place}: the error still says what sf reported`);
        assert.ok(!stripVTControlCharacters(shown).includes(session), `${place}: the error carries no session id`);
        assert.ok(!stripVTControlCharacters(trace).includes(session), `${place}: the trace carries no session id`);
        assert.ok(
          !shown.includes(ESC) && !trace.includes(ESC),
          `${place}: no control sequence reaches the error or the trace`
        );
      }
    }
  });

  test('every token sf handed out stays held: two orgs, one asked for by its second alias, and its token from before a renewal', async () => {
    // Tokens shaped like nothing, so that only holding them can keep them out.
    const handedOut: Record<string, string[]> = {
      'a@example.com': ['FAKE-held-org-a-first-0123', 'FAKE-held-org-a-renewed-4567'],
      'b@example.com': ['FAKE-held-org-b-only-89ab']
    };
    const asked = new Map<string, number>();
    let listFails = false;
    const { client, traced } = loadClient(args => {
      if (isCommand(args, 'org list auth')) {
        if (listFails) return failingWith('stderr', `Request failed with ${Object.values(handedOut).flat().join(' ')}`);
        return ok([
          { username: 'a@example.com', alias: 'a-one,a-two', instanceUrl: ORG.instanceUrl, orgId: ORG.orgId },
          { username: 'b@example.com', alias: 'b-one', instanceUrl: ORG.instanceUrl, orgId: '00D000000000002AAA' }
        ]);
      }
      const username = args[args.indexOf('--target-org') + 1] ?? '';
      const tokens = handedOut[username] ?? [];
      const count = asked.get(username) ?? 0;
      asked.set(username, count + 1);
      return ok({ accessToken: tokens[Math.min(count, tokens.length - 1)] });
    });

    const first = await client.getOrgAuth({ username: 'a-two' });
    await client.getOrgAuth({ username: 'b-one' });
    const renewed = await client.getOrgAuth({ username: 'a-two', rejected: first.accessToken });
    assert.deepEqual(
      [first.accessToken, renewed.accessToken],
      handedOut['a@example.com'],
      'the second alias reaches org a, and its renewal a new token'
    );

    listFails = true;
    const shown = textOf(await rejectionOf(client.orgList({ forceRefresh: true })));
    for (const token of Object.values(handedOut).flat()) {
      assert.ok(!shown.includes(token), `the error carries no ${token}`);
      assert.ok(!traced.join('\n').includes(token), `the trace carries no ${token}`);
    }
  });

  test('a token in the JSON of a failing sf is held before its error is built, so no copy of it reaches the error', async () => {
    const token = 'FAKE-opaque-in-failing-json-0123';
    const { source, traced } = load(() => ({
      code: 1,
      stdout: JSON.stringify({
        status: 1,
        name: 'SfError',
        message: `Request with ${token} failed`,
        result: { accessToken: token }
      }),
      stderr: `Warning: retried with ${token}\n`
    }));

    const shown = textOf(await rejectionOf(source.listOrgs()));

    assert.match(shown, /request with .* failed/i, 'the error still says what sf reported');
    assert.ok(!shown.includes(token), 'the error carries no copy of the token');
    assert.ok(!traced.join('\n').includes(token), 'the trace carries no copy of the token');
  });

  test('a token sf org list auth prints on an older CLI is held, so a later failing sf cannot show it', async () => {
    const token = 'FAKE-opaque-from-org-list-4567';
    let failing = false;
    const { source, traced } = load(() =>
      failing
        ? failingWith('stderr', `Request failed with ${token}`)
        : ok([{ username: ORG.username, accessToken: token, instanceUrl: ORG.instanceUrl }])
    );

    assert.deepEqual(
      (await source.listOrgs()).map(org => org.username),
      [ORG.username]
    );
    failing = true;
    const shown = textOf(await rejectionOf(source.listOrgs()));

    assert.ok(!shown.includes(token), 'the error carries no token from the earlier list');
    assert.ok(!traced.join('\n').includes(token), 'the trace carries no token from the earlier list');
  });

  test('a held token reaches neither the error nor the trace percent-encoded, in either hex case or in a URL', async () => {
    const token = 'FAKE.held!opaque.token-0123456789';
    const everyCharacter = [...token]
      .map(c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
      .join('');
    const encoded = [
      token.replaceAll('!', '%21'),
      token.replaceAll('.', '%2E'),
      token.replaceAll('.', '%2e').replaceAll('!', '%21'),
      everyCharacter,
      `https://example.my.salesforce.com/secur/frontdoor.jsp?sid=${token.replaceAll('!', '%21')}&retURL=%2Flightning`
    ];
    let failure: Exit = { code: 1 };
    const { source, traced } = load(args =>
      isCommand(args, 'org auth show-access-token') ? ok({ accessToken: token }) : failure
    );
    assert.equal((await source.session(ORG, 'first-use')).accessToken, token);

    for (const place of PLACES) {
      for (const form of encoded) {
        failure = failingWith(place, `Request failed with ${form}`);
        traced.length = 0;
        const shown = textOf(await rejectionOf(source.listOrgs()));
        const trace = traced.join('\n');
        const leaked = form.includes('sid=') ? form.slice(form.indexOf('sid=') + 4, form.indexOf('&')) : form;

        assert.match(shown, /request failed with/i, `${place}: the error still says what sf reported`);
        assert.ok(!shown.includes(leaked), `${place}: the error carries no ${form.slice(0, 24)}…`);
        assert.ok(!trace.includes(leaked), `${place}: the trace carries no ${form.slice(0, 24)}…`);
      }
    }
  });

  test('an SFDX auth URL reaches neither the error nor the trace, whatever its refresh token looks like', async () => {
    const refresh = ['FAKE', 'RefreshTokenOtherPrefix0123456789'].join('');
    const urls = [
      ['force:/', '/PlatformCLI::', refresh, '@example.my.salesforce.com'].join(''),
      ['force:/', '/PlatformCLI:', 'FAKEclientSecret0123', ':', refresh, '@example.my.salesforce.com'].join('')
    ];
    for (const place of PLACES) {
      for (const url of urls) {
        const { shown, trace } = await shownFor(place, `Could not use ${url} to log in`);

        assert.match(
          shown,
          /could not use force:\/\/.*@example\.my\.salesforce\.com to log in/i,
          `${place}: the error keeps the instance`
        );
        assert.ok(
          !shown.includes(refresh) && !trace.includes(refresh),
          `${place}: no refresh token in the error or the trace`
        );
        assert.ok(
          !shown.includes('FAKEclientSecret') && !trace.includes('FAKEclientSecret'),
          `${place}: no client secret either`
        );
      }
    }
  });

  /**
   * What a failing `sf` that prints `body` shows, after `sf org list auth` on an older CLI printed `tokens`, in
   * order, so that the extension holds each of them.
   */
  async function shownAfterHolding(tokens: readonly string[], body: string): Promise<{ shown: string; trace: string }> {
    let failing = false;
    const { source, traced } = load(() =>
      failing
        ? failingWith('stderr', body)
        : ok(
            tokens.map((accessToken, index) => ({
              username: `user${index}@example.com`,
              accessToken,
              instanceUrl: ORG.instanceUrl
            }))
          )
    );
    assert.equal((await source.listOrgs()).length, tokens.length);
    failing = true;
    const shown = textOf(await rejectionOf(source.listOrgs()));
    return { shown, trace: traced.join('\n') };
  }

  test('the first token sf handed out stays held after hundreds more', async () => {
    const first = 'FAKE-held-first-of-many-0123';
    const later = Array.from({ length: 300 }, (_, index) => `FAKE-held-later-${String(index).padStart(4, '0')}-89ab`);

    const { shown, trace } = await shownAfterHolding([first, ...later], `Request failed with ${first}`);

    assert.match(shown, /request failed with/i, 'the error still says what sf reported');
    assert.ok(!shown.includes(first), 'the error carries no first token');
    assert.ok(!trace.includes(first), 'the trace carries no first token');
  });

  test('a held token that begins another held token leaves no part of the longer one', async () => {
    const shorter = 'FAKE-held-prefix-0123';
    const longer = `${shorter}-and-its-rest-4567`;

    const { shown, trace } = await shownAfterHolding([shorter, longer], `Request failed with ${longer}`);

    assert.match(shown, /request failed with/i, 'the error still says what sf reported');
    assert.ok(!shown.includes('-and-its-rest-4567'), 'the error carries no rest of the longer token');
    assert.ok(!trace.includes('-and-its-rest-4567'), 'the trace carries no rest of the longer token');
  });

  test('two held tokens that partly overlap in the text leave no part of either', async () => {
    const left = 'FAKE-left-token-shared-0123';
    const right = 'shared-0123-right-token-FAKE';
    const joined = 'FAKE-left-token-shared-0123-right-token-FAKE';

    for (const order of [
      [left, right],
      [right, left]
    ]) {
      const { shown, trace } = await shownAfterHolding(order, `Request failed with ${joined}`);

      assert.match(shown, /request failed with/i, 'the error still says what sf reported');
      for (const part of ['FAKE-left-token', '-right-token-FAKE']) {
        assert.ok(!shown.includes(part), `held as ${order.join(', ')}: the error carries no ${part}`);
        assert.ok(!trace.includes(part), `held as ${order.join(', ')}: the trace carries no ${part}`);
      }
    }
  });

  test('held tokens that cover part of a secret name leave the value after it replaced, in either hold order', async () => {
    const shorter = 'FAKE-BRIDGE-';
    const longer = 'FAKE-BRIDGE-access';
    const value = 'FAKEunheldValue123456';

    for (const order of [
      [shorter, longer],
      [longer, shorter]
    ]) {
      const { shown, trace } = await shownAfterHolding(order, `Request failed with ${shorter}accessToken=${value} end`);

      assert.match(shown, /request failed with/i, 'the error still says what sf reported');
      assert.ok(!shown.includes(value), `held as ${order.join(', ')}: the error carries no named value`);
      assert.ok(!trace.includes(value), `held as ${order.join(', ')}: the trace carries no named value`);
      assert.ok(!shown.includes('FAKE-BRIDGE'), `held as ${order.join(', ')}: the error carries no held token`);
    }
  });

  test('a held token inside a session id leaves no part of it, when a refresh token shape runs into the session id', async () => {
    // Synthetic values, joined at run time so that secret scanners do not take the source for real tokens.
    const held = ['00DFAKEFAKEFAKE1', '5Aep8fake'].join('!');
    const text = ['5Aep8fakefakefakefakefake', held, 'fakefakefakefake/FAKE_SESSION_SUFFIX'].join('');

    const { shown, trace } = await shownAfterHolding([held], `Request failed with ${text} end`);

    assert.ok(!shown.includes('FAKE_SESSION_SUFFIX'), 'the error carries no part of the session id');
    assert.ok(!trace.includes('FAKE_SESSION_SUFFIX'), 'the trace carries no part of the session id');
  });

  test('a held token that starts inside a percent-encoding is replaced, while other characters of it are encoded', async () => {
    // Synthetic values, joined at run time so that secret scanners do not take the source for real tokens.
    const session = ['00DFAKEFAKEFAKE1', 'fakeSession0123'].join('!');
    const encoded = ['00DFAKEFAKEFAKE1', 'fakeSession0123'].join('%21');

    for (const text of [`q=%${encoded} end`, 'x %41%46%41%4b%45tail-token-0123 y']) {
      const tokens = [session, '1FAKEtail-token-0123'];
      const { shown, trace } = await shownAfterHolding(tokens, `Request failed with ${text}`);

      assert.ok(!shown.includes('fakeSession0123'), `${text}: the error carries no part of the session id`);
      assert.ok(!shown.includes('tail-token'), `${text}: the error carries no part of the held token`);
      assert.ok(
        !trace.includes('fakeSession0123') && !trace.includes('tail-token'),
        `${text}: the trace carries neither`
      );
    }
  });

  test('a held token that ends in the first half of a surrogate pair is replaced where the text has that half', async () => {
    const token = 'FAKE-surrogate-\uD83D';

    const { shown, trace } = await shownAfterHolding([token], `Request failed with ${token}\uDE00 end`);

    assert.ok(!shown.includes('FAKE-surrogate-'), 'the error carries no held token');
    assert.ok(!trace.includes('FAKE-surrogate-'), 'the trace carries no held token');
  });

  test('a held token that starts or ends inside a surrogate pair is replaced with all of the pair', async () => {
    for (const [token, text] of [
      ['FAKE-surrogate-\uD83D', 'FAKE-surrogate-\uD83D\uDE00'],
      ['\uDE00FAKE-surrogate-', '\uD83D\uDE00FAKE-surrogate-']
    ] as const) {
      const { shown, trace } = await shownAfterHolding([token], `Request failed with ${text} end`);

      assert.match(
        shown,
        /request failed with \[redacted\] end/i,
        `${JSON.stringify(token)}: the error replaces the pair`
      );
      assert.ok(!/[\uD800-\uDFFF]/.test(shown), `${JSON.stringify(token)}: the error carries no half of the pair`);
      assert.ok(!/[\uD800-\uDFFF]/.test(trace), `${JSON.stringify(token)}: the trace carries no half of the pair`);
    }
  });

  test('held tokens that cover a secret name up to half of a surrogate pair leave the value replaced, in either hold order', async () => {
    const shorter = 'FAKE-HELD-0123';
    const longer = 'HELD-0123sid=\uD83D';

    for (const value of ['\uD83D\uDE00FAKEtail', '%F0%9F%98%80FAKEtail']) {
      for (const order of [
        [shorter, longer],
        [longer, shorter]
      ]) {
        const { shown, trace } = await shownAfterHolding(order, `Request failed with ${shorter}sid=${value} end`);
        const held = `held as ${order.map(token => JSON.stringify(token)).join(', ')}, value ${JSON.stringify(value)}`;

        assert.match(shown, /request failed with/i, 'the error still says what sf reported');
        assert.ok(!shown.includes('FAKEtail'), `${held}: the error carries no named value`);
        assert.ok(!trace.includes('FAKEtail'), `${held}: the trace carries no named value`);
        assert.ok(!shown.includes('HELD-0123'), `${held}: the error carries no held token`);
      }
    }
  });

  test('a failing sf that prints a held token and 150,000 named values fails with each of them replaced', async () => {
    const token = 'FAKE-held-01';

    const { shown, trace } = await shownAfterHolding([token], `${token} ${'sid=x '.repeat(150_000)}`);

    assert.ok(shown.includes('sid=[redacted]'), 'the error still shows what sf printed');
    assert.ok(
      !shown.includes(token) && !trace.includes(token),
      'neither the error nor the trace carries the held token'
    );
    assert.ok(!shown.includes('=x') && !trace.includes('=x'), 'neither the error nor the trace carries a named value');
  });

  test('a held token inside a JSON Web Token leaves no part of the JSON Web Token', async () => {
    // Synthetic segments, joined at run time so that secret scanners do not take the source for a real token.
    const [header, payload, signature] = [
      'eyJhbGciOiJSUzI1NiJ9',
      'eyJzdWIiOiJGQUtFLXN1YmplY3QifQ',
      'FAKEsignatureFAKEsignature0123'
    ];
    const jwt = [header, payload, signature].join('.');

    const { shown, trace } = await shownAfterHolding([payload], `Request failed with token ${jwt} end`);

    assert.match(shown, /request failed with token \[redacted\] end/i, 'the error replaces the whole token');
    assert.match(trace, /request failed with token \[redacted\] end/i, 'the trace replaces the whole token');
  });

  test('a held token inside a JSON Web Token leaves the secret after it replaced, whatever names it', async () => {
    const [header, payload, signature] = [
      'eyJhbGciOiJSUzI1NiJ9',
      'eyJzdWIiOiJGQUtFLXN1YmplY3QifQ',
      'FAKEsignatureFAKEsignature0123'
    ];
    const jwt = [header, payload, signature].join('.');

    for (const [named, secret] of [
      ['-sid=FAKEplainSession0123', 'FAKEplainSession0123'],
      ['-password=FAKEhunter2hunter2', 'FAKEhunter2hunter2'],
      ['-force://cid:FAKEsecret:FAKErefresh0123@login.example.com', 'FAKErefresh0123'],
      ['-Bearer FAKEplainBearerValue123', 'FAKEplainBearerValue123']
    ] as const) {
      const { shown, trace } = await shownAfterHolding([payload], `Request failed with ${jwt}${named} end`);

      assert.ok(!shown.includes(secret), `${named}: the error carries no ${secret}`);
      assert.ok(!trace.includes(secret), `${named}: the trace carries no ${secret}`);
      assert.ok(!shown.includes(signature), `${named}: the error carries no signature`);
    }
  });

  test('a held session right before a named secret leaves the named secret replaced', async () => {
    const session = 'FAKEsession0123456789';
    const shaped = ['00D000000000001AAA', session].join('!');

    for (const [named, secret] of [
      ['Bearer FAKEbearerToken0123', 'FAKEbearerToken0123'],
      ['sid=FAKEplainSession0123', 'FAKEplainSession0123']
    ] as const) {
      const { shown, trace } = await shownAfterHolding([session], `Request failed with ${shaped}${named} end`);

      assert.ok(!shown.includes(secret), `${named}: the error carries no ${secret}`);
      assert.ok(!trace.includes(secret), `${named}: the trace carries no ${secret}`);
    }
  });

  test('a held session inside an SFDX auth URL leaves the client secret of the URL replaced', async () => {
    const session = 'FAKEsession0123456789';
    const url = `force://PlatformCLI:FAKEclientSecret0123:${['00D000000000001AAA', session].join('!')}@example.my.salesforce.com`;

    const { shown, trace } = await shownAfterHolding([session], `Request failed with ${url} end`);

    assert.ok(!shown.includes('FAKEclientSecret0123'), 'the error carries no client secret');
    assert.ok(!trace.includes('FAKEclientSecret0123'), 'the trace carries no client secret');
  });

  test('a named secret that a token shape runs past is replaced to the end of the shape', async () => {
    const session = ['00D000000000001', 'AQFakeSession'].join('!');
    for (const value of [`${session}%TAIL`, `abcdef.${session}%TAIL`]) {
      for (const place of PLACES) {
        const { shown, trace } = await shownFor(place, `Request failed: Bearer ${value} end`);

        assert.match(
          shown,
          /request failed: Bearer \[redacted\] end/i,
          `${place}, ${value}: the error replaces all of it`
        );
        assert.ok(!trace.includes('TAIL'), `${place}, ${value}: the trace carries no part of it`);
      }
    }
  });

  test('a named secret that a token shape with a held session runs past is replaced to the end of the shape', async () => {
    const session = 'FAKEsession0123456789';
    const shaped = ['00D000000000001', session].join('!');

    const { shown, trace } = await shownAfterHolding([session], `Request failed: Bearer ${shaped}%TAIL end`);

    assert.match(shown, /request failed: Bearer \[redacted\] end/i, 'the error replaces all of it');
    assert.match(trace, /request failed: Bearer \[redacted\] end/i, 'the trace replaces all of it');
  });

  test('a held session right after a named secret is replaced to the end of its token shape', async () => {
    const shaped = ['00D000000000001', 'FAKEsession0123456789'].join('!');

    const { shown, trace } = await shownAfterHolding(
      [shaped],
      `Request failed: Bearer FAKEbearer0123${shaped}%TAIL end`
    );

    assert.ok(!shown.includes('TAIL'), 'the error carries no part of the token shape');
    assert.ok(!trace.includes('TAIL'), 'the trace carries no part of the token shape');
  });

  test('a held token that ends in a percent sign leaves no part of its percent-encoded form', async () => {
    for (const [token, carried] of [
      ['FAKE-ends-in-percent-0123%', 'FAKE-ends-in-percent-0123%25'],
      ['FAKE-ends-in-percent-0123%2', 'FAKE-ends-in-percent-0123%252']
    ] as const) {
      const { shown, trace } = await shownAfterHolding([token], `Request failed with ?pw=${carried}&x=1`);

      assert.match(shown, /request failed with \?pw=\[redacted\]&x=1/i, `${carried}: the error replaces all of it`);
      assert.match(trace, /request failed with \?pw=\[redacted\]&x=1/i, `${carried}: the trace replaces all of it`);
    }
  });

  test('percent-encoded bytes that are not well-formed UTF-8 stay as written, and match no held token', async () => {
    const three = 'FAKE-utf8-\uFFFD\uFFFD\uFFFD-0123';
    const four = 'FAKE-utf8-\uFFFD\uFFFD\uFFFD\uFFFD-4567';
    const two = 'FAKE-utf8-\uFFFD\uFFFD-89ab';
    for (const [carried, replaced] of [
      ['FAKE-utf8-%EF%BF%BD%ef%bf%bd%EF%BF%BD-0123', true],
      ['FAKE-utf8-%ED%A0%80-0123', false],
      ['FAKE-utf8-%E0%80%80-0123', false],
      ['FAKE-utf8-%F0%80%80%80-4567', false],
      ['FAKE-utf8-%F4%90%80%80-4567', false],
      ['FAKE-utf8-%C0%80-89ab', false],
      ['FAKE-utf8-%E2%82-89ab', false],
      ['FAKE-utf8-%E%2-89ab', false]
    ] as const) {
      const { shown, trace } = await shownAfterHolding([three, four, two], `Request failed with ?pw=${carried}&x=1`);
      const expected = `?pw=${replaced ? '[redacted]' : carried}&x=1`;

      assert.ok(shown.includes(expected), `${carried}: the error shows ${expected}`);
      assert.ok(trace.includes(expected), `${carried}: the trace shows ${expected}`);
    }
  });

  test('a held token with a percent sign is looked for in time that grows with the text, not its square', async () => {
    const body = `${'a'.repeat(31_999)}%`;
    const started = performance.now();
    const { shown } = await shownAfterHolding([`${'a'.repeat(2000)}%q`], `Request failed with ${body}`);
    const elapsed = performance.now() - started;

    assert.ok(shown.includes(body), 'the text, which holds no token, stays as written');
    assert.ok(elapsed < 1000, `redacting 32 kB took ${Math.round(elapsed)} ms`);
  });

  test('a held token in a long named secret is looked for in time that grows with the text, not its square', async () => {
    const session = 'FAKEsession0123456789';
    const body = `accessToken="${session}${'eyJaaaaaaaaa-'.repeat(12_000)}"`;
    const started = performance.now();
    const { shown } = await shownAfterHolding([session], `Request failed with ${body}`);
    const elapsed = performance.now() - started;

    assert.ok(shown.includes('accessToken=[redacted]'), 'the named secret is replaced');
    assert.ok(elapsed < 1000, `redacting 156 kB took ${Math.round(elapsed)} ms`);
  });

  test('text that starts a JSON Web Token again and again is looked for in time that grows with the text, not its square', async () => {
    const body = 'eyJ-'.repeat(25_000);
    const started = performance.now();
    const { shown } = await shownFor('stderr', `Request failed with ${body}`);
    const elapsed = performance.now() - started;

    assert.ok(shown.includes(body), 'the text, which holds no token, stays as written');
    assert.ok(elapsed < 1000, `redacting 100 kB took ${Math.round(elapsed)} ms`);
  });

  test('a held token that starts a JSON Web Token, repeated, is looked for in time that grows with the text, not its square', async () => {
    const token = 'FAKE-eyJ-held-token-0123';
    const started = performance.now();
    const { shown } = await shownAfterHolding([token], `Request failed with ${token.repeat(16_000)}`);
    const elapsed = performance.now() - started;

    assert.ok(!shown.includes('FAKE-eyJ'), 'every copy of the held token is replaced');
    assert.ok(elapsed < 1000, `redacting 384 kB took ${Math.round(elapsed)} ms`);
  });

  test('the token a successful sf prints still reaches the auth source', async () => {
    const { source, traced } = load(() => ({
      code: 0,
      stdout: JSON.stringify({ status: 0, result: { accessToken: SHAPED_TOKEN } })
    }));

    assert.equal((await source.session(ORG, 'first-use')).accessToken, SHAPED_TOKEN);
    assert.ok(!traced.join('\n').includes(SHAPED_TOKEN), 'the trace carries no token');
  });
});
