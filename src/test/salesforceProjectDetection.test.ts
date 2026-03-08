import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru();

function createVscodeStub(workspaceFolders: Array<{ uri: { fsPath: string } }>) {
  return {
    workspace: { workspaceFolders },
    Range: class {
      constructor(
        public readonly startLine: number,
        public readonly startCharacter: number,
        public readonly endLine: number,
        public readonly endCharacter: number
      ) {}
    }
  };
}

suite('findSalesforceProjectInfo', () => {
  test('finds the first Salesforce project across multi-root workspaces', async () => {
    const plainRoot = path.join('/tmp', 'alv-plain-root');
    const sfRoot = path.join('/tmp', 'alv-salesforce-root');
    const plainProject = path.join(plainRoot, 'sfdx-project.json');
    const sfProject = path.join(sfRoot, 'sfdx-project.json');
    const readCalls: string[] = [];

    const workspaceModule: typeof import('../utils/workspace') = proxyquireStrict('../utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: createVscodeStub([{ uri: { fsPath: plainRoot } }, { uri: { fsPath: sfRoot } }]),
      fs: {
        promises: {
          readFile: async (filePath: string, encoding: string): Promise<string> => {
            assert.equal(encoding, 'utf8');
            readCalls.push(filePath);
            if (filePath === plainProject) {
              const error: NodeJS.ErrnoException = new Error('missing project file');
              error.code = 'ENOENT';
              throw error;
            }
            if (filePath === sfProject) {
              return JSON.stringify({ sourceApiVersion: '62.0' });
            }
            throw new Error(`Unexpected readFile: ${filePath}`);
          }
        }
      }
    });

    const info = await workspaceModule.findSalesforceProjectInfo();
    assert.deepEqual(info, {
      workspaceRoot: sfRoot,
      projectFilePath: sfProject,
      sourceApiVersion: '62.0'
    });
    assert.deepEqual(readCalls, [plainProject, sfProject]);
  });

  test('returns undefined when no workspace folder has sfdx-project.json', async () => {
    const firstRoot = path.join('/tmp', 'alv-root-a');
    const secondRoot = path.join('/tmp', 'alv-root-b');

    const workspaceModule: typeof import('../utils/workspace') = proxyquireStrict('../utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: createVscodeStub([{ uri: { fsPath: firstRoot } }, { uri: { fsPath: secondRoot } }]),
      fs: {
        promises: {
          readFile: async (): Promise<string> => {
            const error: NodeJS.ErrnoException = new Error('missing project file');
            error.code = 'ENOENT';
            throw error;
          }
        }
      }
    });

    const info = await workspaceModule.findSalesforceProjectInfo();
    assert.equal(info, undefined);
  });
});
