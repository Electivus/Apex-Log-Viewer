import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru();

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

suite('ensureApexLogsDir', () => {
  test('buildLogFilePathWithUsername computes paths without creating directories', () => {
    const workspaceRoot = path.join('/tmp', 'alv-workspace');

    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict('../../../../src/utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: {
        workspace: {
          workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
        },
        Range: class {
          constructor(
            public readonly startLine: number,
            public readonly startCharacter: number,
            public readonly endLine: number,
            public readonly endCharacter: number
          ) {}
        }
      },
      fs: {
        promises: {
          mkdir: async (): Promise<never> => {
            throw new Error('pure path builder should not create directories');
          }
        }
      }
    });

    const result = workspaceModule.buildLogFilePathWithUsername(
      'User Name@example.com',
      '07L000000000001AA',
      '2026-03-30T18:39:58.000Z'
    );

    assert.deepEqual(result, {
      dir: path.join(workspaceRoot, 'apexlogs', 'orgs', 'User_Name@example.com', 'logs', '2026-03-30'),
      filePath: path.join(
        workspaceRoot,
        'apexlogs',
        'orgs',
        'User_Name@example.com',
        'logs',
        '2026-03-30',
        '07L000000000001AA.log'
      )
    });
  });

  test('getLogFilePathWithUsername builds org-first dated paths', async () => {
    const workspaceRoot = path.join('/tmp', 'alv-workspace');
    const apexlogsDir = path.join(workspaceRoot, 'apexlogs');
    const datedDir = path.join(
      apexlogsDir,
      'orgs',
      'User_Name@example.com',
      'logs',
      '2026-03-30'
    );
    const mkdirCalls: Array<{ dir: string; options: { recursive: boolean } }> = [];

    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict('../../../../src/utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: {
        workspace: {
          workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
        },
        Range: class {
          constructor(
            public readonly startLine: number,
            public readonly startCharacter: number,
            public readonly endLine: number,
            public readonly endCharacter: number
          ) {}
        }
      },
      fs: {
        promises: {
          mkdir: async (dir: string, options: { recursive: boolean }): Promise<void> => {
            mkdirCalls.push({ dir, options });
          },
          stat: async (): Promise<never> => {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        }
      }
    });

    const result = await workspaceModule.getLogFilePathWithUsername(
      'User Name@example.com',
      '07L000000000001AA',
      '2026-03-30T18:39:58.000Z'
    );

    assert.deepEqual(result, {
      dir: datedDir,
      filePath: path.join(datedDir, '07L000000000001AA.log')
    });
    assert.deepEqual(
      mkdirCalls.map(call => call.dir),
      [apexlogsDir, datedDir]
    );
    assert.equal(mkdirCalls.every(call => call.options.recursive === true), true);
  });

  test('getLogFilePathWithUsername uses unknown-date for invalid start times', async () => {
    const workspaceRoot = path.join('/tmp', 'alv-workspace');
    const apexlogsDir = path.join(workspaceRoot, 'apexlogs');
    const unknownDateDir = path.join(
      apexlogsDir,
      'orgs',
      'User_Name@example.com',
      'logs',
      'unknown-date'
    );

    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict('../../../../src/utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: {
        workspace: {
          workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
        },
        Range: class {
          constructor(
            public readonly startLine: number,
            public readonly startCharacter: number,
            public readonly endLine: number,
            public readonly endCharacter: number
          ) {}
        }
      },
      fs: {
        promises: {
          mkdir: async () => undefined,
          stat: async (): Promise<never> => {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        }
      }
    });

    const result = await workspaceModule.getLogFilePathWithUsername(
      'User Name@example.com',
      '07L000000000001AA',
      'undefined-date'
    );

    assert.deepEqual(result, {
      dir: unknownDateDir,
      filePath: path.join(unknownDateDir, '07L000000000001AA.log')
    });
  });

  test('does not append duplicate apexlogs/ entries when called concurrently', async () => {
    const workspaceRoot = path.join('/tmp', 'alv-workspace');
    const apexlogsDir = path.join(workspaceRoot, 'apexlogs');
    const gitignorePath = path.join(workspaceRoot, '.gitignore');

    let gitignoreContent = 'node_modules/\n';
    let appendCalls = 0;
    let readCalls = 0;

    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict('../../../../src/utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: {
        workspace: {
          workspaceFolders: [{ uri: { fsPath: workspaceRoot } }]
        },
        Range: class {
          constructor(
            public readonly startLine: number,
            public readonly startCharacter: number,
            public readonly endLine: number,
            public readonly endCharacter: number
          ) {}
        }
      },
      fs: {
        promises: {
          mkdir: async (dir: string, options: { recursive: boolean }): Promise<void> => {
            assert.equal(dir, apexlogsDir);
            assert.deepEqual(options, { recursive: true });
          },
          stat: async (filePath: string): Promise<{ isFile: () => boolean }> => {
            assert.equal(filePath, gitignorePath);
            return { isFile: () => true };
          },
          readFile: async (filePath: string, encoding: string): Promise<string> => {
            assert.equal(filePath, gitignorePath);
            assert.equal(encoding, 'utf8');
            readCalls += 1;
            const snapshot = gitignoreContent;
            if (readCalls === 1) {
              // Force overlap so both callers can observe the same pre-append state.
              await delay(25);
            }
            return snapshot;
          },
          appendFile: async (filePath: string, value: string, encoding: string): Promise<void> => {
            assert.equal(filePath, gitignorePath);
            assert.equal(encoding, 'utf8');
            appendCalls += 1;
            gitignoreContent += value;
          }
        }
      }
    });

    await Promise.all([workspaceModule.ensureApexLogsDir(), workspaceModule.ensureApexLogsDir()]);

    const apexlogsEntries = gitignoreContent
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line === 'apexlogs/');
    assert.equal(apexlogsEntries.length, 1);
    assert.equal(appendCalls, 1);
  });
});
