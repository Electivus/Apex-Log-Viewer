const { rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

function safeRm(p) {
  try {
    rmSync(p, { recursive: true, force: true });
    // eslint-disable-next-line no-empty
  } catch (e) {
    console.warn('[test-clean] Failed to remove', p, e && e.message ? e.message : e);
  }
}

const cwd = process.cwd();
const cleanCache = /^1|true$/i.test(String(process.env.CLEAN_VSCODE_CACHE || ''));
if (cleanCache) {
  safeRm(join(cwd, '.vscode-test'));
} else {
  console.log('[test-clean] Skipping removal of .vscode-test cache. Set CLEAN_VSCODE_CACHE=true to purge.');
}
safeRm(join(tmpdir(), 'alv-user-data'));
safeRm(join(tmpdir(), 'alv-extensions'));
console.log('[test-clean] Cleaned temp VS Code dirs.');
