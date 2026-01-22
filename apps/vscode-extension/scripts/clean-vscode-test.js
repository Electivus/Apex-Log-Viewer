const { rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

function safeRm(p, { quiet } = {}) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (e) {
    if (!quiet) {
      console.warn('[test-clean] Failed to remove', p, e && e.message ? e.message : e);
    }
  }
}

function cleanVsCodeTest({ quiet = false, force = false } = {}) {
  const cwd = process.cwd();
  const keepCache = !force && /^1|true$/i.test(String(process.env.KEEP_VSCODE_TEST_CACHE || process.env.KEEP_VSCODE_CACHE || ''));
  if (keepCache) {
    if (!quiet) {
      console.log('[test-clean] KEEP_VSCODE_TEST_CACHE is set; preserving .vscode-test cache.');
    }
  } else {
    safeRm(join(cwd, '.vscode-test'), { quiet });
    if (!quiet) {
      console.log('[test-clean] Removed .vscode-test cache.');
    }
  }
  safeRm(join(tmpdir(), 'alv-user-data'), { quiet });
  safeRm(join(tmpdir(), 'alv-extensions'), { quiet });
  if (!quiet) {
    console.log('[test-clean] Cleaned temp VS Code dirs.');
  }
}

if (require.main === module) {
  cleanVsCodeTest();
}

module.exports = { cleanVsCodeTest };
