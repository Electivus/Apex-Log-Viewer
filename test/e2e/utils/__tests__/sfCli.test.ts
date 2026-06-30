const execFileMock = jest.fn();

jest.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}));

function failCommand(error: NodeJS.ErrnoException, stdout = '', stderr = ''): void {
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
  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.SF_CLI_BIN_PATH;
    delete process.env.SF_CLI_NODE_PATH;
  });

  afterEach(() => {
    delete process.env.SF_CLI_BIN_PATH;
    delete process.env.SF_CLI_NODE_PATH;
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
});
