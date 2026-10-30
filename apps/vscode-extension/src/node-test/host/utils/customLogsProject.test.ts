import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const { findCustomLogsProjectDir } = proxyquireStrict('../../../host/utils/workspace', {
  vscode: { workspace: { workspaceFolders: undefined } },
  './logger': { logWarn: () => undefined }
}) as typeof import('../../../host/utils/workspace');

const { findCustomLogsOffset } = proxyquireStrict('../../../host/utils/customLogsConfig', {
  vscode: {},
  './localize': { localize: (_key: string, message: string) => message },
  './workspace': { findCustomLogsProjectDir: async () => undefined }
}) as typeof import('../../../host/utils/customLogsConfig');

function folder(fsPath: string): { uri: never } {
  return { uri: { fsPath } as never };
}

suite('Custom Logs project lookup', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-custom-logs-project-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('uses the workspace folder that holds sfdx-project.json, whatever its position', async () => {
    const docs = path.join(root, 'docs');
    const project = path.join(root, 'project');
    fs.mkdirSync(docs);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'sfdx-project.json'), '{}');

    assert.equal(await findCustomLogsProjectDir([folder(docs), folder(project)]), project);
  });

  test('hands core a project file that does not parse, so core reports it', async () => {
    fs.writeFileSync(path.join(root, 'sfdx-project.json'), '{ "plugins": ');

    assert.equal(await findCustomLogsProjectDir([folder(root)]), root);
  });

  test('falls back to the first folder, which core walks up from, and to nothing without a workspace', async () => {
    const nested = path.join(root, 'force-app');
    fs.mkdirSync(nested);

    assert.equal(await findCustomLogsProjectDir([folder(nested)]), nested);
    assert.equal(await findCustomLogsProjectDir([]), undefined);
    assert.equal(await findCustomLogsProjectDir(undefined), undefined);
  });
});

suite('Custom Logs config locator', () => {
  test('finds the customLogs key under plugins.electivus', () => {
    const text =
      '{\n  "plugins": {\n    "other": { "customLogs": 1 },\n    "electivus": {\n      "customLogs": { "sources": [] }\n    }\n  }\n}';

    const offset = findCustomLogsOffset(text);

    assert.equal(text.slice(offset, offset! + '"customLogs"'.length), '"customLogs"');
    assert.ok(offset! > text.indexOf('"electivus"'));
  });

  test('finds nothing when the project has no Custom Logs mapping', () => {
    assert.equal(findCustomLogsOffset('{ "plugins": { "electivus": { "other": true } } }'), undefined);
    assert.equal(findCustomLogsOffset('{ "packageDirectories": [] }'), undefined);
  });
});
