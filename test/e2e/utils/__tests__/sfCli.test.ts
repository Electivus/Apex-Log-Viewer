const execFileMock = jest.fn();
const path = require('node:path');

jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}));

function failCommand(error: Error, stdout = '', stderr = ''): void {
  const callback = execFileMock.mock.calls.at(-1)?.[3] as (error: unknown, stdout: string, stderr: string) => void;
  callback(error, stdout, stderr);
}

function passCommand(stdout: string, stderr = ''): void {
  const callback = execFileMock.mock.calls.at(-1)?.[3] as (error: unknown, stdout: string, stderr: string) => void;
  callback(null, stdout, stderr);
}

async function waitForExecCallCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (execFileMock.mock.calls.length >= count) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for execFile call #${count}.`);
}

async function importSfCli(): Promise<typeof import('../sfCli')> {
  jest.resetModules();
  return require('../sfCli') as typeof import('../sfCli');
}

describe('runSfJson failure diagnostics', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.SF_CLI_BIN_PATH;
    delete process.env.SF_CLI_NODE_PATH;
    delete process.env.ALV_SF_BIN_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('reports missing Salesforce CLI executable with PATH guidance', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await waitForExecCallCount(1);
    const resolveError = new Error('command not found') as NodeJS.ErrnoException;
    resolveError.code = 1;
    failCommand(resolveError);

    await waitForExecCallCount(2);
    const missingError = new Error('spawn sf ENOENT') as NodeJS.ErrnoException;
    missingError.code = 'ENOENT';
    failCommand(missingError);

    await expect(promise).rejects.toThrow(
      /Salesforce CLI executable 'sf' was not found\. Check PATH or install Salesforce CLI for the Node\/test environment\./
    );
  });

  test('includes exit code when Salesforce CLI exits without JSON details', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await waitForExecCallCount(1);
    passCommand('/usr/local/bin/sf\n');

    await waitForExecCallCount(2);
    const exitError = new Error('Command failed') as NodeJS.ErrnoException;
    exitError.code = 127;
    failCommand(exitError);

    await expect(promise).rejects.toThrow(/Process failed with exit code 127\./);
  });

  test('includes signal when Salesforce CLI is terminated without JSON details', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await waitForExecCallCount(1);
    passCommand('/usr/local/bin/sf\n');

    await waitForExecCallCount(2);
    const signalError = new Error('Command terminated') as NodeJS.ErrnoException & { signal?: string };
    signalError.signal = 'SIGTERM';
    failCommand(signalError);

    await expect(promise).rejects.toThrow(/Process failed with signal SIGTERM\./);
  });

  test('keeps parsed Salesforce CLI JSON errors readable', async () => {
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await waitForExecCallCount(1);
    passCommand('/usr/local/bin/sf\n');

    await waitForExecCallCount(2);
    const exitError = new Error('Command failed') as NodeJS.ErrnoException;
    exitError.code = 1;
    failCommand(exitError, '{"name":"NamedOrgNotFoundError","message":"No authorization information found."}\n');

    await expect(promise).rejects.toThrow(/NamedOrgNotFoundError: No authorization information found\./);
  });

  test('exports usable scratch credentials only in the consuming child environment', async () => {
    process.env.SF_CLI_BIN_PATH = process.platform === 'win32' ? 'C:\\Tools\\sf.cmd' : '/opt/sf';
    const { runSfJson } = await importSfCli();
    const authUrl = 'force://PlatformCLI::test-refresh-token@scratch.my.salesforce.com';
    const promise = runSfJson(['org', 'auth', 'show-sfdx-auth-url', '--target-org', 'Scratch', '--no-prompt']);
    await waitForExecCallCount(1);
    const env = execFileMock.mock.calls[0]?.[2].env;
    passCommand(JSON.stringify({ status: 0, result: { sfdxAuthUrl: authUrl } }));
    await expect(promise).resolves.toMatchObject({ result: { sfdxAuthUrl: authUrl } });
    expect(env.SF_TEMP_SHOW_SECRETS).toBe('true');
    expect(process.env.SF_TEMP_SHOW_SECRETS).toBeUndefined();
  });

  test.each([
    '[REDACTED] use sf org auth',
    'force://redacted',
    'force://PlatformCLI::***@scratch.my.salesforce.com',
    'force://PlatformCLI::token@https://scratch.my.salesforce.com'
  ])('rejects unusable credential export %# without echoing it', async authUrl => {
    process.env.SF_CLI_BIN_PATH = process.platform === 'win32' ? 'C:\\Tools\\sf.cmd' : '/opt/sf';
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'auth', 'show-sfdx-auth-url', '--target-org', 'Scratch', '--no-prompt']);
    const assertion = expect(promise).rejects.toThrow('usable SFDX authorization URL');
    await waitForExecCallCount(1);
    passCommand(JSON.stringify({ status: 0, result: { sfdxAuthUrl: authUrl } }));
    await assertion;
  });

  test('credential export failures never copy credential values from CLI errors', async () => {
    process.env.SF_CLI_BIN_PATH = process.platform === 'win32' ? 'C:\\Tools\\sf.cmd' : '/opt/sf';
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'auth', 'show-sfdx-auth-url', '--target-org', 'Scratch', '--no-prompt']);
    const assertion = promise.catch(error => {
      expect(error.message).toMatch(/failed/i);
      expect(error.stack).not.toMatch(/unknown-consumer-secret|private-refresh-token|PRIVATE KEY/);
    });
    await waitForExecCallCount(1);
    failCommand(
      Object.assign(new Error('private-refresh-token'), { code: 1 }),
      JSON.stringify({
        name: 'AuthError',
        message: 'unknown-consumer-secret force://PlatformCLI::private-refresh-token@host.example'
      })
    );
    await assertion;
  });

  test('ordinary commands strip inherited JWT, export and signup settings', async () => {
    process.env.SF_CLI_BIN_PATH = process.platform === 'win32' ? 'C:\\Tools\\sf.cmd' : '/opt/sf';
    process.env.SF_TEMP_SHOW_SECRETS = 'true';
    process.env.SF_DEVHUB_PRIVATE_KEY = 'test-private-key';
    process.env.SF_DEVHUB_AUTH_URL = 'test-legacy-url';
    process.env.SF_SCRATCH_SIGNUP_CONNECTED_APP = 'WrongApp';
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['data', 'query', '--target-org', 'Scratch', '--query', 'SELECT Id FROM Organization']);
    await waitForExecCallCount(1);
    const env = execFileMock.mock.calls[0]?.[2].env;
    for (const name of [
      'SF_TEMP_SHOW_SECRETS',
      'SF_DEVHUB_PRIVATE_KEY',
      'SF_DEVHUB_AUTH_URL',
      'SF_SCRATCH_SIGNUP_CONNECTED_APP'
    ]) {
      expect(env[name]).toBeUndefined();
    }
    passCommand('{"status":0,"result":{"records":[]}}');
    await promise;
    expect(process.env.SF_TEMP_SHOW_SECRETS).toBe('true');
  });

  test.each(['[REDACTED]', 'force://PlatformCLI::token@https://host.example'])(
    'rejects malformed scratch import %# before CLI execution',
    async value => {
      const fs = require('node:fs');
      const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'alv-import-test-'));
      try {
        const file = path.join(directory, 'scratch.sfdxurl');
        fs.writeFileSync(file, value);
        const { runSfJson } = await importSfCli();
        await expect(runSfJson(['org', 'login', 'sfdx-url', '--sfdx-url-file', file])).rejects.toThrow(
          'usable SFDX authorization URL'
        );
        expect(execFileMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  test('uses explicit Salesforce CLI Node runtime when configured', async () => {
    process.env.SF_CLI_NODE_PATH = '/opt/hostedtoolcache/node/22/bin/node';
    const { resolveSfCliInvocation } = await importSfCli();
    const promise = resolveSfCliInvocation();

    await waitForExecCallCount(1);
    passCommand('/usr/local/bin/sf\n');

    await expect(promise).resolves.toEqual({
      sfBinPath: '/usr/local/bin/sf',
      nodeBinPath: '/opt/hostedtoolcache/node/22/bin/node'
    });
  });

  test('skips the workspace Electivus plugin sf shim when resolving Salesforce CLI', async () => {
    const { resolveSfCliInvocation } = await importSfCli();
    const promise = resolveSfCliInvocation();

    await waitForExecCallCount(1);
    passCommand(`${path.join(process.cwd(), 'node_modules', '.bin', 'sf')}\n/usr/local/bin/sf\n`);

    await expect(promise).resolves.toEqual({
      sfBinPath: '/usr/local/bin/sf',
      nodeBinPath: process.execPath
    });
  });

  test('uses explicit Salesforce CLI binary path when configured', async () => {
    process.env.SF_CLI_BIN_PATH = '/opt/hostedtoolcache/node/22/bin/sf';
    process.env.SF_CLI_NODE_PATH = '/opt/hostedtoolcache/node/22/bin/node';
    const { resolveSfCliInvocation } = await importSfCli();

    await expect(resolveSfCliInvocation()).resolves.toEqual({
      sfBinPath: '/opt/hostedtoolcache/node/22/bin/sf',
      nodeBinPath: '/opt/hostedtoolcache/node/22/bin/node'
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test('uses configured Salesforce CLI binary path for setup commands', async () => {
    const configuredSfPath = process.platform === 'win32' ? 'C:\\Tools\\sf.cmd' : '/opt/hostedtoolcache/node/20/bin/sf';
    process.env.SF_CLI_BIN_PATH = configuredSfPath;
    process.env.SF_CLI_NODE_PATH =
      process.platform === 'win32' ? 'C:\\Tools\\node.exe' : '/opt/hostedtoolcache/node/20/bin/node';
    const { runSfJson } = await importSfCli();
    const promise = runSfJson(['org', 'display', '-o', 'ConfiguredDevHub']);

    await waitForExecCallCount(1);
    if (process.platform === 'win32') {
      expect(String(execFileMock.mock.calls[0]?.[0]).toLowerCase()).toContain('cmd');
      expect((execFileMock.mock.calls[0]?.[1] as string[]).slice(0, 4)).toEqual(['/d', '/s', '/c', configuredSfPath]);
    } else {
      expect(execFileMock.mock.calls[0]?.[0]).toBe(configuredSfPath);
    }
    passCommand('{"status":0,"result":{"username":"devhub@example.com"}}\n');

    await expect(promise).resolves.toEqual({
      status: 0,
      result: { username: 'devhub@example.com' }
    });
  });
});
