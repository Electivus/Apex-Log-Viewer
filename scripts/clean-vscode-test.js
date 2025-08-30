const { rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

function safeRm(p) {
  try {
    rmSync(p, { recursive: true, force: true });
    // eslint-disable-next-line no-empty
  } catch {}
}

const cwd = process.cwd();
safeRm(join(cwd, '.vscode-test'));
safeRm(join(tmpdir(), 'alv-user-data'));
safeRm(join(tmpdir(), 'alv-extensions'));
console.log('[test-clean] Cleaned .vscode-test and temp VS Code dirs.');

