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
  test('keeps scanning later roots when an earlier project file is unreadable', async () => {
    const blockedRoot = path.join('/tmp', 'alv-blocked-root');
    const sfRoot = path.join('/tmp', 'alv-salesforce-root');
    const blockedProject = path.join(blockedRoot, 'sfdx-project.json');
    const sfProject = path.join(sfRoot, 'sfdx-project.json');
    const readCalls: string[] = [];

    const workspaceModule: typeof import('../utils/workspace') = proxyquireStrict('../utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: createVscodeStub([{ uri: { fsPath: blockedRoot } }, { uri: { fsPath: sfRoot } }]),
      fs: {
        promises: {
          readFile: async (filePath: string, encoding: string): Promise<string> => {
            assert.equal(encoding, 'utf8');
            readCalls.push(filePath);
            if (filePath === blockedProject) {
              const error: NodeJS.ErrnoException = new Error('project file is unreadable');
              error.code = 'EACCES';
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
    assert.deepEqual(readCalls, [blockedProject, sfProject]);
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

  test('returns undefined when only unreadable project files are seen', async () => {
    const blockedRoot = path.join('/tmp', 'alv-blocked-root');

    const workspaceModule: typeof import('../utils/workspace') = proxyquireStrict('../utils/workspace', {
      './logger': {
        logInfo: () => undefined,
        logWarn: () => undefined
      },
      vscode: createVscodeStub([{ uri: { fsPath: blockedRoot } }]),
      fs: {
        promises: {
          readFile: async (): Promise<string> => {
            const error: NodeJS.ErrnoException = new Error('project file is unreadable');
            error.code = 'EACCES';
            throw error;
          }
        }
      }
    });

    const info = await workspaceModule.findSalesforceProjectInfo();
    assert.equal(info, undefined);
  });
});
