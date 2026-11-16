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
    './proxy': { readProxySettings: () => ({}) }
  }) as typeof import('../../host/salesforce/sfCliAuth');
  return { source: module.createSfCliAuthSource({ projectDir: () => undefined }), traced };
}

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

  test('the token a successful sf prints still reaches the auth source', async () => {
    const { source, traced } = load(() => ({
      code: 0,
      stdout: JSON.stringify({ status: 0, result: { accessToken: SHAPED_TOKEN } })
    }));

    assert.equal((await source.session(ORG, 'first-use')).accessToken, SHAPED_TOKEN);
    assert.ok(!traced.join('\n').includes(SHAPED_TOKEN), 'the trace carries no token');
  });
});
