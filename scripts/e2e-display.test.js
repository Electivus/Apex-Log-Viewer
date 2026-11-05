const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { shouldShowVsCode, shouldUseXvfb } = require('./e2e-display');

test('VS Code stays hidden unless ALV_E2E_SHOW_VSCODE opts in', () => {
  for (const value of [undefined, '', '0', 'false', 'no', 'yes']) {
    assert.equal(shouldShowVsCode({ ALV_E2E_SHOW_VSCODE: value }), false, `value ${value}`);
  }
  for (const value of ['1', 'true', 'TRUE', ' True ']) {
    assert.equal(shouldShowVsCode({ ALV_E2E_SHOW_VSCODE: value }), true, `value ${value}`);
  }
});

test('Linux uses Xvfb even with a DISPLAY unless VS Code should show', () => {
  assert.equal(shouldUseXvfb({}, 'linux'), true);
  assert.equal(shouldUseXvfb({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(shouldUseXvfb({ DISPLAY: ':0', ALV_E2E_SHOW_VSCODE: '1' }, 'linux'), false);
  // There is nothing to show VS Code on without a DISPLAY.
  assert.equal(shouldUseXvfb({ ALV_E2E_SHOW_VSCODE: '1' }, 'linux'), true);
});

test('a run already under Xvfb and other platforms are not wrapped', () => {
  assert.equal(shouldUseXvfb({ DISPLAY: ':99', __ALV_XVFB_RAN: '1' }, 'linux'), false);
  assert.equal(shouldUseXvfb({}, 'darwin'), false);
  assert.equal(shouldUseXvfb({}, 'win32'), false);
});

test('the shell launchers read the opt-in from the exit code', () => {
  const script = path.join(__dirname, 'e2e-display.js');
  const run = value =>
    spawnSync(process.execPath, [script], { env: { ...process.env, ALV_E2E_SHOW_VSCODE: value } }).status;
  assert.equal(run('1'), 0);
  assert.equal(run(''), 1);
});
