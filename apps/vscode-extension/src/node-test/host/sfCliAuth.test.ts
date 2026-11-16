import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import proxyquire from 'proxyquire';

import type { SalesforceProxySettings, SourceOrg } from '@alv/core';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

type SfRun = { program: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };
type SfAnswer = (run: SfRun) => { stdout: string; stderr?: string };

const ORG: SourceOrg = {
  username: 'dev@example.com',
  instanceUrl: 'https://dev.my.salesforce.com',
  orgId: '00D000000000001AAA'
};

const ok = (result: unknown) => ({ stdout: JSON.stringify({ status: 0, result }) });

/** What exec.ts rejects with when the program exits non-zero. */
function exited(code: number, streams: { stdout?: string; stderr?: string }): never {
  throw Object.assign(new Error(`Command "sf" exited with code ${code}: ${streams.stderr ?? ''}`), {
    code,
    stdout: streams.stdout ?? '',
    stderr: streams.stderr ?? ''
  });
}

const commandMissing = () => exited(127, { stderr: 'Warning: org auth show-access-token is not a sf command.' });

/** The sf subcommand of a run, without its flags. */
function commandOf(run: SfRun): string {
  const firstFlag = run.args.findIndex(arg => arg.startsWith('-'));
  return run.args.slice(0, firstFlag).join(' ');
}

/** The auth source over a scripted `sf`: every run is recorded and `answer` plays the CLI. */
function loadSource(
  answer: SfAnswer,
  options: {
    projectDir?: string;
    loginEnv?: NodeJS.ProcessEnv;
    proxy?: SalesforceProxySettings;
    /** The VS Code display language's bundle, English message to translation; none is English. */
    translations?: Record<string, string>;
  } = {}
) {
  const runs: SfRun[] = [];
  const translations = options.translations ?? {};
  const module = proxyquireStrict('../../host/salesforce/sfCliAuth', {
    './exec': {
      CLI_TIMEOUT_MS: 120_000,
      execCommand: async (
        program: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        _timeoutMs: number,
        _signal: AbortSignal | undefined,
        cwd?: string
      ) => {
        const run = { program, args, env, cwd };
        runs.push(run);
        return { stderr: '', ...answer(run) };
      }
    },
    './path': { getLoginShellEnv: async () => options.loginEnv ?? { PATH: '/usr/bin' } },
    './proxy': { readProxySettings: () => options.proxy ?? {} },
    '../utils/localize': {
      localize: (_key: string, message: string, ...args: Array<string | number>) =>
        (translations[message] ?? message).replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    }
  }) as typeof import('../../host/salesforce/sfCliAuth');
  const source = module.createSfCliAuthSource({ projectDir: () => options.projectDir });
  return { module, source, runs, commands: () => runs.map(commandOf) };
}

/** A CLI from before `org auth show-access-token`: `org display` prints the token. */
const olderCli: SfAnswer = run =>
  commandOf(run) === 'org auth show-access-token'
    ? commandMissing()
    : ok({ accessToken: 'token-display', instanceUrl: ORG.instanceUrl, id: ORG.orgId });

suite('sf CLI auth source', () => {
  test('a session asks sf org auth show-access-token once per call and nothing else', async () => {
    const { source, runs, commands } = loadSource(() => ok({ accessToken: 'token-current' }));

    assert.deepEqual(await source.session(ORG, 'first-use'), {
      accessToken: 'token-current',
      instanceUrl: ORG.instanceUrl,
      orgId: ORG.orgId
    });
    await source.session(ORG, 'rejected');

    assert.deepEqual(commands(), ['org auth show-access-token', 'org auth show-access-token']);
    assert.deepEqual(runs[0]?.args, [
      'org',
      'auth',
      'show-access-token',
      '--target-org',
      ORG.username,
      '--no-prompt',
      '--json'
    ]);
  });

  test('a CLI without show-access-token answers from org display, and the next session goes straight there', async () => {
    const { source, commands } = loadSource(olderCli);

    assert.equal((await source.session(ORG, 'first-use')).accessToken, 'token-display');
    assert.equal((await source.session(ORG, 'rejected')).accessToken, 'token-display');

    assert.deepEqual(commands(), ['org auth show-access-token', 'org display', 'org display']);
  });

  test('"is not a sf command" without exit code 127 also counts as a missing command', async () => {
    const { source, commands } = loadSource(run =>
      commandOf(run) === 'org auth show-access-token'
        ? exited(2, { stderr: 'org auth show-access-token is not a sf command.' })
        : ok({ accessToken: 'token-display', instanceUrl: ORG.instanceUrl })
    );

    assert.equal((await source.session(ORG, 'first-use')).accessToken, 'token-display');
    assert.deepEqual(commands(), ['org auth show-access-token', 'org display']);
  });

  test('a redacted display after the command was missing asks show-access-token again: the CLI was updated', async () => {
    let updated = false;
    const { source, commands } = loadSource(run => {
      if (commandOf(run) === 'org auth show-access-token') {
        return updated ? ok({ accessToken: 'token-updated' }) : commandMissing();
      }
      return ok({ accessToken: updated ? '[REDACTED]' : 'token-display', instanceUrl: ORG.instanceUrl });
    });
    await source.session(ORG, 'first-use');

    updated = true;
    assert.equal((await source.session(ORG, 'rejected')).accessToken, 'token-updated');
    assert.equal((await source.session(ORG, 'rejected')).accessToken, 'token-updated');

    assert.deepEqual(commands(), [
      'org auth show-access-token',
      'org display',
      'org display',
      'org auth show-access-token',
      'org auth show-access-token'
    ]);
  });

  test('a CLI that hides the token in display and has no show-access-token asks for an update', async () => {
    const { source } = loadSource(run =>
      commandOf(run) === 'org auth show-access-token'
        ? commandMissing()
        : ok({ accessToken: 'Use "sf org auth show-access-token" to see your access token.' })
    );

    await assert.rejects(source.session(ORG, 'first-use'), { code: 'SF_CLI_UNSUPPORTED' });
  });

  test('show-access-token that prints no usable token fails instead of sending a placeholder', async () => {
    const { source } = loadSource(() => ok({ accessToken: '[REDACTED]' }));

    await assert.rejects(source.session(ORG, 'first-use'), { code: 'SF_CLI_FAILED' });
  });

  test('a missing sf binary is SF_CLI_NOT_FOUND', async () => {
    const { source } = loadSource(() => {
      throw Object.assign(new Error('CLI not found: sf org list auth --json'), { code: 'ENOENT' });
    });

    await assert.rejects(source.listOrgs(), { code: 'SF_CLI_NOT_FOUND' });
    await assert.rejects(source.session(ORG, 'first-use'), { code: 'SF_CLI_NOT_FOUND' });
  });

  test('with only the deprecated sfdx on the PATH, the missing sf says to install the current Salesforce CLI', async () => {
    const withSfdx = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-sfdx-only-'));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-no-cli-'));
    try {
      // sfdx-cli 7 installs `sfdx` and no `sf`; Windows finds it through its .cmd shim.
      for (const name of ['sfdx', 'sfdx.cmd']) fs.writeFileSync(path.join(withSfdx, name), '', { mode: 0o755 });
      const missing = () => {
        throw Object.assign(new Error('CLI not found: sf org list auth --json'), { code: 'ENOENT' });
      };
      const legacyOnly = loadSource(missing, { loginEnv: { PATH: [empty, withSfdx].join(path.delimiter) } });
      const neither = loadSource(missing, { loginEnv: { PATH: empty } });

      await assert.rejects(legacyOnly.source.listOrgs(), (error: { code?: string; message: string }) => {
        assert.equal(error.code, 'SF_CLI_NOT_FOUND');
        assert.match(error.message, /sfdx/);
        assert.match(error.message, /install the current Salesforce CLI/i);
        assert.match(error.message, /npm install --global @salesforce\/cli/);
        return true;
      });
      await assert.rejects(neither.source.listOrgs(), (error: { code?: string; message: string }) => {
        assert.equal(error.code, 'SF_CLI_NOT_FOUND');
        assert.doesNotMatch(error.message, /sfdx/, 'no sfdx, no word about it');
        return true;
      });
    } finally {
      fs.rmSync(withSfdx, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a failing sf reports the message of its JSON error', async () => {
    const failure = JSON.stringify({
      status: 1,
      name: 'NamedOrgNotFoundError',
      message: 'No authorization information found for dev@example.com.'
    });
    const onStderr = loadSource(() => exited(1, { stderr: failure }));
    const onStdout = loadSource(() => exited(1, { stdout: failure }));

    for (const { source } of [onStderr, onStdout]) {
      await assert.rejects(source.session(ORG, 'first-use'), {
        code: 'SF_CLI_FAILED',
        message: 'No authorization information found for dev@example.com.'
      });
    }
  });

  test('a username with spaces stays one argument', async () => {
    const { source, runs } = loadSource(() => ok({ accessToken: 'token-current' }));

    await source.session({ ...ORG, username: 'dev user@example.com' }, 'first-use');

    assert.equal(runs[0]?.args[runs[0].args.indexOf('--target-org') + 1], 'dev user@example.com');
  });

  test('sf runs in the project folder, else in the home folder', async () => {
    const inProject = loadSource(() => ok([]), { projectDir: '/work/project' });
    const outside = loadSource(() => ok([]));

    await inProject.source.listOrgs();
    await outside.source.listOrgs();

    assert.equal(inProject.runs[0]?.cwd, '/work/project');
    assert.equal(outside.runs[0]?.cwd, os.homedir());
  });

  test('sf skips its log file, version check and autoupdate unless the user set them', async () => {
    const { source, runs } = loadSource(() => ok([]), {
      loginEnv: { PATH: '/usr/bin', sf_disable_log_file: 'false', ALV_SF_BIN_PATH: '/opt/sf/bin/sf' }
    });

    await source.listOrgs();

    const env = runs[0]!.env;
    assert.equal(runs[0]?.program, '/opt/sf/bin/sf');
    assert.equal(env.sf_disable_log_file, 'false');
    assert.equal(env.SF_DISABLE_LOG_FILE, undefined, 'a value the user set, in any case, wins');
    assert.equal(env.SF_SKIP_NEW_VERSION_CHECK, 'true');
    assert.equal(env.SF_DISABLE_AUTOUPDATE, 'true');
    assert.equal(env.PATH, '/usr/bin');
  });

  test("sf sends its own Salesforce requests through VS Code's http.proxy, over the proxy variables", async () => {
    const loginEnv = { PATH: '/usr/bin', https_proxy: 'http://env-proxy:3128', HTTP_PROXY: 'http://env-proxy:3128' };
    const configured = loadSource(() => ok([]), {
      loginEnv,
      proxy: { proxyUrl: 'http://vscode-proxy:8080', noProxy: ['internal.example.com', '.corp'] }
    });
    const unset = loadSource(() => ok([]), { loginEnv, proxy: {} });

    await configured.source.listOrgs();
    await unset.source.listOrgs();

    const env = configured.runs[0]!.env;
    assert.equal(env.HTTPS_PROXY, 'http://vscode-proxy:8080');
    assert.equal(env.HTTP_PROXY, 'http://vscode-proxy:8080');
    assert.equal(env.https_proxy, undefined, 'no variable spelling is left to win over http.proxy');
    assert.equal(env.NO_PROXY, 'internal.example.com,.corp');
    assert.equal(unset.runs[0]!.env.https_proxy, 'http://env-proxy:3128', 'without http.proxy the variables stay');
    assert.equal(unset.runs[0]!.env.NO_PROXY, undefined);
  });

  test('listOrgs reads sf org list auth through an allowlist that keeps no token', async () => {
    const { source, commands } = loadSource(() =>
      ok([
        {
          username: 'dev@example.com',
          alias: 'dev, dev-old',
          orgId: ORG.orgId,
          instanceUrl: ORG.instanceUrl,
          accessToken: 'token-listed',
          configs: ['target-org']
        },
        { username: 'hub@example.com', configs: ['target-dev-hub'], isScratchOrg: false },
        { username: 'legacy@example.com', configs: ['defaultusername', 'defaultdevhubusername'] },
        { alias: 'no-username' }
      ])
    );

    const orgs = await source.listOrgs();

    assert.deepEqual(commands(), ['org list auth']);
    assert.deepEqual(orgs, [
      {
        username: 'dev@example.com',
        alias: 'dev',
        aliases: ['dev', 'dev-old'],
        orgId: ORG.orgId,
        instanceUrl: ORG.instanceUrl,
        isScratchOrg: false,
        isDefaultUsername: true,
        isDefaultDevHubUsername: false
      },
      {
        username: 'hub@example.com',
        alias: undefined,
        aliases: [],
        orgId: undefined,
        instanceUrl: undefined,
        isScratchOrg: false,
        isDefaultUsername: false,
        isDefaultDevHubUsername: true
      },
      {
        username: 'legacy@example.com',
        alias: undefined,
        aliases: [],
        orgId: undefined,
        instanceUrl: undefined,
        isScratchOrg: false,
        isDefaultUsername: true,
        isDefaultDevHubUsername: true
      }
    ]);
    assert.doesNotMatch(JSON.stringify(orgs), /token-listed/);
  });

  test('parseOrgListAuth answers an empty list for anything but an array', () => {
    const { module } = loadSource(() => ok([]));

    assert.deepEqual(module.parseOrgListAuth(undefined), []);
    assert.deepEqual(module.parseOrgListAuth({ username: 'dev@example.com' }), []);
  });

  test('JSON that sf colors because FORCE_COLOR is set still answers', async () => {
    // What sf prints for --json when FORCE_COLOR reaches it, as it does from a VS Code that Playwright starts.
    const colored = (result: unknown) => ({
      stdout: JSON.stringify({ status: 0, result }, null, 2)
        .replace(/[{}[\]]/g, bracket => `\u001b[1m${bracket}\u001b[22m`)
        .replace(/"[^"]*"(?=:)/g, key => `\u001b[94m${key}\u001b[39m`)
    });
    const { source } = loadSource(run =>
      commandOf(run) === 'org list auth'
        ? colored([{ username: ORG.username, instanceUrl: ORG.instanceUrl, orgId: ORG.orgId }])
        : colored({ accessToken: 'token-colored' })
    );

    const orgs = await source.listOrgs();
    const session = await source.session(ORG, 'first-use');

    assert.deepEqual(
      orgs.map(org => org.username),
      [ORG.username]
    );
    assert.equal(session.accessToken, 'token-colored');
  });
});

suite('sf CLI auth source in the VS Code display language', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');
  const ptBr: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'l10n', 'bundle.l10n.pt-br.json'), 'utf8')
  );
  const missing = () => {
    throw Object.assign(new Error('CLI not found: sf org list auth --json'), { code: 'ENOENT' });
  };
  const orgWithoutUrl: SourceOrg = { username: ORG.username, orgId: ORG.orgId } as SourceOrg;

  /** What the auth source tells a user in each of its failures and in the update hint, with `translations`. */
  async function messagesIn(translations: Record<string, string>): Promise<Record<string, string>> {
    const withSfdx = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-l10n-sfdx-'));
    fs.writeFileSync(path.join(withSfdx, 'sfdx'), '', { mode: 0o755 });
    const failureOf = async (pending: Promise<unknown>) =>
      pending.then(
        () => assert.fail('the call should fail'),
        (error: Error) => error.message
      );
    try {
      return {
        'only sfdx': await failureOf(
          loadSource(missing, { translations, loginEnv: { PATH: withSfdx } }).source.listOrgs()
        ),
        'no sf': await failureOf(
          loadSource(missing, { translations, loginEnv: { PATH: '/nonexistent' } }).source.listOrgs()
        ),
        'no JSON': await failureOf(loadSource(() => ({ stdout: 'not json' }), { translations }).source.listOrgs()),
        'no token': await failureOf(loadSource(() => ok({}), { translations }).source.session(ORG, 'first-use')),
        'no instance URL': await failureOf(
          loadSource(() => ok({ accessToken: 'token-no-url' }), { translations }).source.session(
            orgWithoutUrl,
            'first-use'
          )
        ),
        'token hidden': await failureOf(
          loadSource(
            run => (commandOf(run) === 'org auth show-access-token' ? commandMissing() : ok({ accessToken: '' })),
            {
              translations
            }
          ).source.session(ORG, 'first-use')
        ),
        'update hint':
          (await loadSource(() => ({ stdout: '@salesforce/cli/2.152.8 darwin-arm64 node-v24.22.2\n' }), {
            translations
          }).source.updateHint()) ?? 'no hint'
      };
    } finally {
      fs.rmSync(withSfdx, { recursive: true, force: true });
    }
  }

  test('in Portuguese, every message it shows a user comes from the pt-BR bundle', async () => {
    const english = await messagesIn({});
    const portuguese = await messagesIn(ptBr);

    for (const [failure, message] of Object.entries(english)) {
      assert.notEqual(portuguese[failure], message, `${failure}: "${message}" has a pt-BR translation`);
    }
    const hint = portuguese['update hint'] ?? '';
    assert.match(hint, /2\.152\.8/, 'the hint still names the installed release');
    assert.match(hint, /2\.152\.9/, 'and the release that keeps the login');
  });
});
