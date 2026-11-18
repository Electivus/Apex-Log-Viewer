const { rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { quiet: false, force: false };
  for (const a of argv) {
    if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--force' || a === '-f') out.force = true;
  }
  return out;
}

function safeRm(p, { quiet } = {}) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (e) {
    if (!quiet) {
      console.warn('[test-clean] Failed to remove', p, e && e.message ? e.message : e);
    }
  }
}

function cacheCleanRequested() {
  const { env } = process;
  const requestedCleanCache = /^1|true$/i.test(String(env.CLEAN_VSCODE_TEST_CACHE || env.CLEAN_VSCODE_CACHE || ''));
  // Backwards compatible: KEEP_* vars previously preserved cache. Cache is now
  // preserved by default; KEEP_* still overrides CLEAN_* (but not --force).
  const explicitlyKeepCache = /^1|true$/i.test(String(env.KEEP_VSCODE_TEST_CACHE || env.KEEP_VSCODE_CACHE || ''));
  return !explicitlyKeepCache && requestedCleanCache;
}

function cleanVsCodeTest({ quiet = false, force = false } = {}) {
  const cwd = process.cwd();
  const cleanCache = force || cacheCleanRequested();

  if (cleanCache) {
    safeRm(join(cwd, '.vscode-test'), { quiet });
    if (!quiet) {
      console.log('[test-clean] Removed .vscode-test cache (forced).');
    }
  } else if (!quiet) {
    console.log('[test-clean] Preserving .vscode-test cache.');
  }

  safeRm(join(tmpdir(), 'alv-user-data'), { quiet });

  // Keep extensions cache by default (integration tests reuse it).
  // Still remove legacy temp dirs and smoke-test dirs for isolation.
  safeRm(join(tmpdir(), 'alv-extensions'), { quiet });
  safeRm(join(tmpdir(), 'alv-extensions-unit'), { quiet });

  if (!quiet) {
    console.log('[test-clean] Cleaned temp VS Code dirs.');
  }
}

if (require.main === module) {
  const args = parseArgs();
  cleanVsCodeTest(args);
}

module.exports = { cacheCleanRequested };
