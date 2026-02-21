import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru();

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

suite('ensureApexLogsDir', () => {
  test('does not append duplicate apexlogs/ entries when called concurrently', async () => {
    const workspaceRoot = path.join('/tmp', 'alv-workspace');
    const apexlogsDir = path.join(workspaceRoot, 'apexlogs');
    const gitignorePath = path.join(workspaceRoot, '.gitignore');

    let gitignoreContent = 'node_modules/\n';
    let appendCalls = 0;
    let readCalls = 0;

    const workspaceModule: typeof import('../utils/workspace') = proxyquireStrict('../utils/workspace', {
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
