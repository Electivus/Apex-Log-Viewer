import assert from 'assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');

type FakeDocument = { uri: { scheme: string }; fileName: string; apex: boolean };

function loadContext() {
  const setContextCalls: Array<[string, unknown]> = [];
  let onActiveEditor: (() => void) | undefined;
  let onChangeDocument: ((event: { document: FakeDocument }) => void) | undefined;
  const window = { activeTextEditor: undefined as { document: FakeDocument } | undefined };
  const vscodeStub = {
    window: Object.assign(window, {
      onDidChangeActiveTextEditor: (listener: () => void) => {
        onActiveEditor = listener;
        return { dispose: () => undefined };
      }
    }),
    workspace: {
      onDidChangeTextDocument: (listener: (event: { document: FakeDocument }) => void) => {
        onChangeDocument = listener;
        return { dispose: () => undefined };
      }
    },
    commands: {
      executeCommand: async (command: string, key: string, value: unknown) => {
        assert.equal(command, 'setContext');
        setContextCalls.push([key, value]);
      }
    },
    Disposable: { from: (...items: Array<{ dispose(): void }>) => ({ dispose: () => items.forEach(i => i.dispose()) }) }
  };
  const module = proxyquireStrict('../../host/apexLogEditorContext', {
    vscode: vscodeStub,
    './utils/workspace': { isApexLogDocument: (doc: FakeDocument) => doc.apex }
  }) as typeof import('../../host/apexLogEditorContext');
  return {
    module,
    window,
    setContextCalls,
    activate: (document: FakeDocument | undefined) => {
      window.activeTextEditor = document ? { document } : undefined;
      onActiveEditor?.();
    },
    change: (document: FakeDocument) => onChangeDocument?.({ document })
  };
}

const apexLog: FakeDocument = { uri: { scheme: 'file' }, fileName: '/w/apexlogs/07L.log', apex: true };
const plainLog: FakeDocument = { uri: { scheme: 'file' }, fileName: '/w/server.log', apex: false };

suite('Apex log editor context', () => {
  test('tracks whether the active editor shows an Apex log, whatever its language mode', () => {
    const harness = loadContext();
    const key = harness.module.ACTIVE_EDITOR_IS_APEX_LOG;
    harness.window.activeTextEditor = { document: apexLog };

    const disposable = harness.module.registerApexLogEditorContext();
    harness.activate(plainLog);
    harness.activate(plainLog);
    harness.activate(undefined);
    harness.activate({ ...apexLog, uri: { scheme: 'git' } });
    harness.activate(apexLog);

    assert.deepEqual(harness.setContextCalls, [
      [key, true],
      [key, false],
      [key, true]
    ]);
    disposable.dispose();
  });

  test('re-checks the active document when its text changes', () => {
    const harness = loadContext();
    const pasted: FakeDocument = { ...plainLog, fileName: '/w/new.log' };
    harness.window.activeTextEditor = { document: pasted };
    harness.module.registerApexLogEditorContext();

    pasted.apex = true;
    harness.change(apexLog);
    harness.change(pasted);

    assert.deepEqual(
      harness.setContextCalls.map(([, value]) => value),
      [false, true]
    );
  });
});

suite('Apex log language contribution', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/vscode-extension/package.json'), 'utf8'));
  const language = manifest.contributes.languages.find((entry: { id: string }) => entry.id === 'apexlog');
  const firstLine = new RegExp(language.firstLine);

  test('detects the header line of real Apex logs', () => {
    const corpus = fs.readFileSync(path.join(repoRoot, 'test/agent-debug/corpus.json'), 'utf8');
    const corpusHeaders = corpus.match(/\d+\.\d+ APEX_CODE,[A-Z]+[^"\\]*/g) ?? [];
    assert.ok(corpusHeaders.length > 0, 'the corpus should contain Apex log headers');
    for (const header of [
      ...corpusHeaders,
      '60.0 APEX_CODE,DEBUG;APEX_PROFILING,ERROR;CALLOUT,ERROR;DB,INFO;NBA,ERROR;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,ERROR;WAVE,INFO;WORKFLOW,INFO',
      '9.0 APEX_CODE,FINEST'
    ]) {
      assert.match(header, firstLine);
    }
  });

  test('leaves other logs alone', () => {
    for (const line of [
      '2026-11-05 21:00:00.000 INFO starting server',
      '13:00:01.000 (1234)|EXECUTION_STARTED',
      'APEX_CODE,DEBUG;APEX_PROFILING,ERROR'
    ]) {
      assert.doesNotMatch(line, firstLine);
    }
  });

  test('shows the editor-title button for Apex logs that open in the Log language mode', () => {
    const button = manifest.contributes.menus['editor/title'].find(
      (entry: { command: string }) => entry.command === 'electivus.apexLogViewer.log.openViewer'
    );
    assert.match(button.when, /resourceLangId == apexlog/);
    assert.match(button.when, /electivus\.apexLogViewer\.activeEditorIsApexLog/);
  });
});
