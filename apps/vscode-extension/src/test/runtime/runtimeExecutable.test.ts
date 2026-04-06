import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveRuntimeExecutable } from '../../runtime/runtimeExecutable';

function readJson(relativePath: string): any {
  const filePath = path.resolve(__dirname, '..', '..', '..', relativePath);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

suite('runtime executable', () => {
  test('configured runtimePath wins over bundled path', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'alv-runtime-'));

    try {
      const configuredFile = path.join(tempDir, 'apex-log-viewer');
      writeFileSync(configuredFile, '');
      if (process.platform !== 'win32') {
        chmodSync(configuredFile, 0o755);
      }

      const result = resolveRuntimeExecutable({
        configuredPath: configuredFile,
        bundledPath: '/tmp/bundled/apex-log-viewer'
      });

      assert.equal(result.executable, configuredFile);
      assert.equal(result.source, 'configured');
      assert.equal(result.showManualOverrideWarning, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('non-executable configured runtimePath falls back to the bundled path on POSIX', () => {
    if (process.platform === 'win32') {
      return;
    }

    const tempDir = mkdtempSync(path.join(tmpdir(), 'alv-runtime-'));

    try {
      const configuredFile = path.join(tempDir, 'apex-log-viewer');
      writeFileSync(configuredFile, '');
      chmodSync(configuredFile, 0o644);

      const result = resolveRuntimeExecutable({
        configuredPath: configuredFile,
        bundledPath: '/tmp/bundled/apex-log-viewer'
      });

      assert.equal(result.executable, '/tmp/bundled/apex-log-viewer');
      assert.equal(result.source, 'bundled');
      assert.equal(result.showManualOverrideWarning, false);
      assert.equal(result.invalidConfiguredPath, configuredFile);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('blank runtimePath falls back to the bundled path', () => {
    const result = resolveRuntimeExecutable({
      configuredPath: '   ',
      bundledPath: '/tmp/bundled/apex-log-viewer'
    });

    assert.equal(result.executable, '/tmp/bundled/apex-log-viewer');
    assert.equal(result.source, 'bundled');
    assert.equal(result.showManualOverrideWarning, false);
  });

  test('relative runtimePath falls back to the bundled path', () => {
    const result = resolveRuntimeExecutable({
      configuredPath: './bin/apex-log-viewer',
      bundledPath: '/tmp/bundled/apex-log-viewer'
    });

    assert.equal(result.executable, '/tmp/bundled/apex-log-viewer');
    assert.equal(result.source, 'bundled');
    assert.equal(result.showManualOverrideWarning, false);
  });

  test('missing or URI-style runtimePath falls back to the bundled path', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'alv-runtime-'));

    try {
      const configuredFile = path.join(tempDir, 'apex-log-viewer');
      const missingFile = path.join(tempDir, 'missing-apex-log-viewer');
      writeFileSync(configuredFile, '');

      const missingResult = resolveRuntimeExecutable({
        configuredPath: missingFile,
        bundledPath: '/tmp/bundled/apex-log-viewer'
      });
      assert.equal(missingResult.executable, '/tmp/bundled/apex-log-viewer');
      assert.equal(missingResult.source, 'bundled');
      assert.equal(missingResult.showManualOverrideWarning, false);

      const uriResult = resolveRuntimeExecutable({
        configuredPath: `file://${configuredFile.replace(/\\/g, '/')}`,
        bundledPath: '/tmp/bundled/apex-log-viewer'
      });
      assert.equal(uriResult.executable, '/tmp/bundled/apex-log-viewer');
      assert.equal(uriResult.source, 'bundled');
      assert.equal(uriResult.showManualOverrideWarning, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('manifest exposes electivus.apexLogs.runtimePath as a string setting', () => {
    const packageJson = readJson('package.json');

    assert.equal(
      packageJson.contributes.configuration.properties['electivus.apexLogs.runtimePath']?.type,
      'string'
    );
    assert.equal(
      packageJson.contributes.configuration.properties['electivus.apexLogs.runtimePath']?.default,
      ''
    );
  });

  test('settings NLS copy exists for the manual override warning text', () => {
    const packageNls = readJson('package.nls.json');
    const packageNlsPtBr = readJson('package.nls.pt-br.json');

    assert.equal(
      packageNls['configuration.electivus.apexLogs.runtimePath.description'],
      'DEVELOPMENT ONLY: Path to the Apex Log Viewer CLI executable. You do NOT need to set this unless you are actively developing the Apex Log Viewer CLI. If set manually, parts of the extension may not work as expected.'
    );
    assert.match(
      packageNlsPtBr['configuration.electivus.apexLogs.runtimePath.description'],
      /DESENVOLVIMENTO|desenvolvendo|CLI/i
    );
  });
});
