/**
 * The child process of `authFiles.test.ts`. It runs extension operations against a fake org in a
 * throwaway HOME and prints one JSON line: per phase, whether the Salesforce auth files changed and
 * which writes this process attempted under `~/.sfdx` and `~/.sf`. It runs in its own process
 * because the Salesforce libraries read HOME when they load. Tokens are fake and never printed.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USERNAME = 'ext-user@example.com';
const ORG_ID = '00D000000000001AAA';
const USER_ID = '005000000000001AAA';

const home = process.env.HOME as string;
const repoRoot = process.env.ALV_TEST_REPO_ROOT as string;
const fakeSfPath = process.env.ALV_SF_BIN_PATH as string;
const generation = process.env.ALV_TEST_FAKE_SF_GENERATION === 'old' ? 'old' : 'new';

type FakeOrg = { serial: number; access: string; refresh: string };

function startFakeOrg() {
  const org: FakeOrg = { serial: 0, access: `${USERNAME}-access-0`, refresh: `${USERNAME}-refresh-0` };
  const seen = { accepted: 0, rejected: 0, tokenGrants: 0, acceptedAfterRenewal: 0 };
  let renewedAt = Number.POSITIVE_INFINITY;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === '/services/data') {
        send(200, [{ label: 'Fake', url: '/services/data/v63.0', version: '63.0' }]);
        return;
      }
      if (url.pathname === '/services/oauth2/token') {
        if (new URLSearchParams(body).get('refresh_token') !== org.refresh) {
          send(400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
          return;
        }
        seen.tokenGrants++;
        org.refresh = `${USERNAME}-refresh-${org.serial}`;
        send(200, {
          access_token: org.access,
          refresh_token: org.refresh,
          instance_url: baseUrl,
          id: `${baseUrl}/id/${ORG_ID}/${USER_ID}`,
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          signature: 'fake'
        });
        return;
      }
      // What the fake `sf` reads: the session the org currently accepts, as a working `sf` would return it.
      if (url.pathname === '/fake-sf/session') {
        send(200, { accessToken: org.access, instanceUrl: baseUrl, orgId: ORG_ID, username: USERNAME });
        return;
      }
      if (String(request.headers.authorization ?? '') !== `Bearer ${org.access}`) {
        seen.rejected++;
        send(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
        return;
      }
      seen.accepted++;
      if (Date.now() >= renewedAt) seen.acceptedAfterRenewal++;
      const soql = url.searchParams.get('q') ?? '';
      if (/\/query\/?$/.test(url.pathname)) {
        const records = /\bFROM\s+User\b/i.test(soql) ? [{ Id: USER_ID, Name: 'Ext User', Username: USERNAME }] : [];
        send(200, { totalSize: records.length, done: true, records });
        return;
      }
      if (/\/chatter\/users\/me$/.test(url.pathname)) {
        send(200, { id: USER_ID });
        return;
      }
      send(200, {});
    });
  });
  let baseUrl = '';
  return new Promise<{
    url: string;
    org: FakeOrg;
    seen: typeof seen;
    expire(): void;
    close(): Promise<void>;
  }>(resolve =>
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        url: baseUrl,
        org,
        seen,
        expire() {
          org.serial++;
          org.access = `${USERNAME}-access-${org.serial}`;
          renewedAt = Date.now();
        },
        close: () =>
          new Promise<void>(done => {
            server.closeAllConnections();
            server.close(() => done());
          })
      });
    })
  );
}

/** Auth files as `sf org login` leaves them, written by the library `sf` itself uses, in a separate process. */
function seedAuthFiles(instanceUrl: string, org: FakeOrg): void {
  const sfCore = require.resolve('@salesforce/core', { paths: [path.join(repoRoot, 'packages', 'sf-plugin')] });
  const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toLocaleString();
  const script = `
    const { StateAggregator } = require(${JSON.stringify(sfCore)});
    (async () => {
      const state = await StateAggregator.getInstance();
      state.orgs.set(${JSON.stringify(USERNAME)}, ${JSON.stringify({
        username: USERNAME,
        orgId: ORG_ID,
        instanceUrl,
        loginUrl: instanceUrl,
        accessToken: org.access,
        refreshToken: org.refresh,
        clientId: 'PlatformCLI',
        instanceApiVersion: '63.0',
        instanceApiVersionLastRetrieved: stale
      })});
      await state.orgs.write(${JSON.stringify(USERNAME)});
      await state.aliases.setAndSave('ext', ${JSON.stringify(USERNAME)});
    })().catch(error => { console.error(error && error.message); process.exit(1); });`;
  const seeded = spawnSync(process.execPath, ['-e', script], { cwd: home, env: process.env, encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(`seeding auth files failed: ${seeded.stderr}`);
}

/** A fake `sf` executable of either CLI generation, answering from the fake org's current session. */
function writeFakeSf(instanceUrl: string): void {
  const script = path.join(path.dirname(fakeSfPath), 'fake-sf.cjs');
  fs.writeFileSync(
    script,
    `'use strict';
const http = require('node:http');
const args = process.argv.slice(2);
const generation = ${JSON.stringify(generation)};
const command = args.filter(arg => !arg.startsWith('-')).slice(0, 3).join(' ');
require('node:fs').appendFileSync(process.env.ALV_TEST_FAKE_SF_LOG, command.replace(/ \\S+@\\S+$/, '') + '\\n');
function print(result) { process.stdout.write(JSON.stringify({ status: 0, result })); }
http.get(${JSON.stringify(`${instanceUrl}/fake-sf/session`)}, response => {
  let body = '';
  response.on('data', chunk => (body += chunk));
  response.on('end', () => {
    const session = JSON.parse(body);
    const org = { username: session.username, alias: 'ext', orgId: session.orgId, instanceUrl: session.instanceUrl,
      loginUrl: session.instanceUrl, isDefaultUsername: false, isDefaultDevHubUsername: false, connectedStatus: 'Unknown' };
    if (command === 'org list auth') {
      return print([{ username: org.username, alias: org.alias, orgId: org.orgId, instanceUrl: org.instanceUrl, configs: [],
        isScratchOrg: false, oauthMethod: 'web', accessToken: generation === 'new' ? '[REDACTED]' : session.accessToken }]);
    }
    if (command === 'org list') return print({ other: [], sandboxes: [], nonScratchOrgs: [org], devHubs: [], scratchOrgs: [] });
    if (command.startsWith('org auth show-access-token') && generation === 'new') return print({ accessToken: session.accessToken });
    if (command.startsWith('org auth show-access-token')) {
      process.stderr.write(' \\u203a   Warning: org auth show-access-token is not a sf command.\\n');
      process.exit(127);
    }
    if (command.startsWith('org display')) {
      return print({ ...org, id: session.orgId, accessToken: generation === 'new' ? '[REDACTED]' : session.accessToken });
    }
    process.stderr.write('fake sf: unsupported command ' + command + '\\n');
    process.exit(2);
  });
}).on('error', error => { process.stderr.write(String(error)); process.exit(1); });
`
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeSfPath, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(fakeSfPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
}

const sfLog = path.join(path.dirname(fakeSfPath), 'sf-commands.log');

function sfCommands(): string[] {
  return fs.existsSync(sfLog) ? fs.readFileSync(sfLog, 'utf8').split('\n').filter(Boolean) : [];
}

function authFingerprint(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full, { bigint: true });
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        out[path.relative(home, full)] = `${digest}:${stat.mtimeNs}`;
      }
    }
  };
  walk(path.join(home, '.sfdx'));
  walk(path.join(home, '.sf'));
  return out;
}

/** Records every fs call this process makes that could write under `~/.sfdx` or `~/.sf`. */
function watchWrites(): string[] {
  const attempts: string[] = [];
  const roots = ['.sfdx', '.sf'].map(name => path.resolve(home, name));
  const stateFile = (target: unknown): string | undefined => {
    const file =
      typeof target === 'string'
        ? target
        : target instanceof URL
          ? fileURLToPath(target)
          : Buffer.isBuffer(target)
            ? target.toString()
            : undefined;
    if (!file) return undefined;
    const resolved = path.resolve(file);
    return roots.some(root => resolved === root || resolved.startsWith(root + path.sep))
      ? path.relative(home, resolved)
      : undefined;
  };
  const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
  const writes = (flags: unknown): boolean =>
    typeof flags === 'number'
      ? (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0
      : typeof flags === 'string' && /[wa+]/.test(flags);
  type Pick = (args: unknown[]) => unknown[];
  const wrap = (target: Record<string, unknown>, name: string, targets: Pick): void => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (this: unknown, ...args: unknown[]) {
      for (const candidate of targets(args)) {
        const file = stateFile(candidate);
        if (file) attempts.push(`${name} ${file}`);
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  const first: Pick = args => [args[0]];
  const both: Pick = args => [args[0], args[1]];
  const openWrites: Pick = args => (writes(args[1]) ? [args[0]] : []);
  const streamWrites: Pick = args => [args[0]];
  for (const target of [fs as unknown as Record<string, unknown>]) {
    for (const name of ['open', 'openSync']) wrap(target, name, openWrites);
    for (const name of ['createWriteStream']) wrap(target, name, streamWrites);
    for (const name of [
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'truncate',
      'truncateSync',
      'unlink',
      'unlinkSync',
      'rm',
      'rmSync',
      'rmdir',
      'rmdirSync',
      'mkdir',
      'mkdirSync',
      'utimes',
      'utimesSync'
    ]) {
      wrap(target, name, first);
    }
    for (const name of [
      'rename',
      'renameSync',
      'copyFile',
      'copyFileSync',
      'symlink',
      'symlinkSync',
      'link',
      'linkSync'
    ]) {
      wrap(target, name, both);
    }
  }
  const promises = fs.promises as unknown as Record<string, unknown>;
  wrap(promises, 'open', openWrites);
  for (const name of ['writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir', 'utimes']) {
    wrap(promises, name, first);
  }
  for (const name of ['rename', 'copyFile', 'symlink', 'link']) wrap(promises, name, both);
  return attempts;
}

function stubVscode(): void {
  const noop = (): void => undefined;
  const disposable = { dispose: noop };
  const channel = new Proxy({}, { get: (_target, key) => (key === 'logLevel' ? 0 : noop) });
  const vscode = {
    window: {
      createOutputChannel: () => channel,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
        has: () => false,
        inspect: noop
      }),
      workspaceFolders: undefined,
      onDidChangeConfiguration: () => disposable
    },
    env: {
      language: 'en',
      machineId: 'test',
      sessionId: 'test',
      isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: () => disposable
    },
    l10n: {
      t: (message: string | { message: string }, ...args: unknown[]) =>
        (typeof message === 'string' ? message : message.message).replace(/\{(\d+)\}/g, (_m, i) =>
          String(args[Number(i)])
        )
    },
    extensions: { getExtension: () => undefined },
    Uri: { file: (fsPath: string) => ({ fsPath, path: fsPath, toString: () => fsPath }) },
    EventEmitter: class {
      public event = () => disposable;
      public fire = noop;
      public dispose = noop;
    },
    Disposable: class {
      public static from = () => disposable;
      public dispose = noop;
    },
    LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
    version: '1.100.0'
  };
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = loader._load;
  loader._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
}

type Phase = {
  name: string;
  authFilesChanged: string[];
  writeAttempts: string[];
  errors: string[];
  sfCommands: string[];
};

async function main(): Promise<void> {
  const fake = await startFakeOrg();
  seedAuthFiles(fake.url, fake.org);
  writeFakeSf(fake.url);
  process.env.ALV_TEST_FAKE_SF_LOG = sfLog;
  stubVscode();
  const attempts = watchWrites();

  const projectDir = path.join(home, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const { CoreClient } = require('../../runtime/runtimeClient') as typeof import('../../runtime/runtimeClient');
  const traceflags = require('../../host/salesforce/traceflags') as typeof import('../../host/salesforce/traceflags');
  const client = new CoreClient({ workspaceRoot: () => projectDir });

  const phases: Phase[] = [];
  const runPhase = async (name: string, steps: Array<[string, () => Promise<unknown>]>): Promise<void> => {
    const before = authFingerprint();
    const from = attempts.length;
    const commandsFrom = sfCommands().length;
    const errors: string[] = [];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        errors.push(`${step}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
    }
    const after = authFingerprint();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      file => before[file] !== after[file]
    );
    phases.push({
      name,
      authFilesChanged: changed.sort(),
      writeAttempts: attempts.slice(from),
      errors,
      sfCommands: sfCommands().slice(commandsFrom)
    });
  };

  const operations = (): Array<[string, () => Promise<unknown>]> => [
    ['org list', () => client.orgList({ forceRefresh: true })],
    ['org resolve', () => client.orgResolve({ targetOrg: 'ext' })],
    ['log list', () => client.logsList({ username: USERNAME, limit: 5 })],
    [
      'trace flag status',
      () => client.traceFlagStatus({ targetOrg: USERNAME, target: { type: 'user', userId: 'current' } })
    ],
    ['debug level list', () => client.debugLevelsList({ targetOrg: USERNAME })],
    ['user search', () => client.usersSearch({ targetOrg: USERNAME, query: 'Ext' })],
    ['tooling query', () => client.toolingQuery({ targetOrg: USERNAME, soql: 'SELECT Id FROM ApexClass LIMIT 1' })],
    ['host debug levels', async () => traceflags.listDebugLevels(await client.getOrgAuth({ username: USERNAME }))]
  ];

  await runPhase('valid session', operations());
  fake.expire();
  await runPhase('rejected session', operations());
  await client.dispose();
  await fake.close();

  process.stdout.write(
    `${JSON.stringify({
      phases,
      rejectedRequests: fake.seen.rejected,
      acceptedAfterRenewal: fake.seen.acceptedAfterRenewal
    })}\n`
  );
}

main().then(
  () => process.exit(0),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
);
