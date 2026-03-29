import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveRuntimeExecutable } from '../../runtime/runtimeExecutable';

function readJson(relativePath: string): any {
  const filePath = path.resolve(__dirname, '..', '..', '..', relativePath);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

suite('runtime executable', () => {
  test('configured runtimePath wins over bundled path', () => {
    const result = resolveRuntimeExecutable({
      configuredPath: '/tmp/custom/apex-log-viewer',
      bundledPath: '/tmp/bundled/apex-log-viewer'
    });

    assert.equal(result.executable, '/tmp/custom/apex-log-viewer');
    assert.equal(result.source, 'configured');
    assert.equal(result.showManualOverrideWarning, true);
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
