import assert from 'assert/strict';
import proxyquire from 'proxyquire';

const workspaceModule: typeof import('../host/utils/workspace') = proxyquire('../host/utils/workspace', {
  vscode: {
    workspace: { workspaceFolders: undefined },
    Range: class {
      constructor(
        public readonly startLine: number,
        public readonly startCharacter: number,
        public readonly endLine: number,
        public readonly endCharacter: number
      ) {}
    }
  }
});

const { getLogIdFromLogFilePath } = workspaceModule;

suite('getLogIdFromLogFilePath', () => {
  test('extracts log id from org-first log filenames', () => {
    const result = getLogIdFromLogFilePath(
      '/tmp/apexlogs/orgs/default@example.com/logs/2026-03-30/07L000000000001AA.log'
    );
    assert.equal(result, '07L000000000001AA');
  });

  test('returns undefined for username-prefixed flat filenames', () => {
    const result = getLogIdFromLogFilePath('/tmp/default_07L000000000001AA.log');
    assert.equal(result, undefined);
  });

  test('returns undefined for non-matching filenames', () => {
    const result = getLogIdFromLogFilePath('/tmp/custom.log.txt');
    assert.equal(result, undefined);
  });
});
