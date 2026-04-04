import assert from 'assert/strict';
import * as path from 'path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function directoryEntry(name: string) {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false
  };
}

suite('findExistingLogFile runtime lookup', () => {
  test('prefers the runtime-resolved cached path', async () => {
    const resolveCalls: Array<{ logId: string; username?: string; workspaceRoot?: string }> = [];
    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict(
      '../../../../src/utils/workspace',
      {
        vscode: {
          workspace: {
            workspaceFolders: [{ uri: { fsPath: '/tmp/alv-workspace' } }]
          }
        },
        '../../apps/vscode-extension/src/runtime/runtimeClient': {
          runtimeClient: {
            resolveCachedLogPath: async (params: { logId: string; username?: string; workspaceRoot?: string }) => {
              resolveCalls.push(params);
              return {
                path: '/tmp/alv-workspace/apexlogs/orgs/demo@example.com/logs/2026-03-30/07L000000000001AA.log'
              };
            }
          }
        },
        './logger': {
          logInfo: () => undefined,
          logWarn: () => undefined
        }
      }
    );

    const result = await workspaceModule.findExistingLogFile('07L000000000001AA', 'demo@example.com');

    assert.equal(
      result,
      '/tmp/alv-workspace/apexlogs/orgs/demo@example.com/logs/2026-03-30/07L000000000001AA.log'
    );
    assert.deepEqual(resolveCalls, [
      {
        logId: '07L000000000001AA',
        username: 'demo@example.com',
        workspaceRoot: '/tmp/alv-workspace'
      }
    ]);
  });

  test('falls back to local lookup when the runtime request fails', async () => {
    const localPath = path.join('/tmp/alv-workspace', 'apexlogs', 'demo_07L000000000002AA.log');
    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict(
      '../../../../src/utils/workspace',
      {
        vscode: {
          workspace: {
            workspaceFolders: [{ uri: { fsPath: '/tmp/alv-workspace' } }]
          }
        },
        '../../apps/vscode-extension/src/runtime/runtimeClient': {
          runtimeClient: {
            resolveCachedLogPath: async () => {
              throw new Error('daemon unavailable');
            }
          }
        },
        fs: {
          promises: {
            readdir: async (target: string, options?: { withFileTypes?: boolean }) => {
              if (target.endsWith(path.join('orgs', 'demo', 'logs'))) {
                return [];
              }
              if (options?.withFileTypes) {
                return [];
              }
              return ['demo_07L000000000002AA.log'];
            }
          }
        },
        './logger': {
          logInfo: () => undefined,
          logWarn: () => undefined
        }
      }
    );

    const result = await workspaceModule.findExistingLogFile('07L000000000002AA', 'demo');

    assert.equal(result, localPath);
  });

  test('ignores unsupported local log subdirectories when the runtime request fails', async () => {
    const logId = '07L000000000003AA';
    const offLayout = path.join('/tmp/alv-workspace', 'apexlogs', 'orgs', 'demo', 'logs', 'archive', `${logId}.log`);
    const workspaceModule: typeof import('../../../../src/utils/workspace') = proxyquireStrict(
      '../../../../src/utils/workspace',
      {
        vscode: {
          workspace: {
            workspaceFolders: [{ uri: { fsPath: '/tmp/alv-workspace' } }]
          }
        },
        '../../apps/vscode-extension/src/runtime/runtimeClient': {
          runtimeClient: {
            resolveCachedLogPath: async () => {
              throw new Error('daemon unavailable');
            }
          }
        },
        fs: {
          promises: {
            readdir: async (target: string, options?: { withFileTypes?: boolean }) => {
              if (options?.withFileTypes && target.endsWith(path.join('orgs', 'demo', 'logs'))) {
                return [directoryEntry('archive')];
              }
              if (options?.withFileTypes) {
                return [];
              }
              return [];
            },
            stat: async (target: string) => {
              if (target === offLayout) {
                return { isFile: () => true };
              }
              throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            }
          }
        },
        './logger': {
          logInfo: () => undefined,
          logWarn: () => undefined
        }
      }
    );

    const result = await workspaceModule.findExistingLogFile(logId, 'demo');

    assert.equal(result, undefined);
  });
});
