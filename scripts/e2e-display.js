'use strict';

// Playwright E2E keeps VS Code out of sight unless ALV_E2E_SHOW_VSCODE=1 (or true).
// Linux runs it on a private Xvfb display. macOS and Windows have no virtual display,
// so test/e2e/utils/vscode.ts makes the native window transparent instead.
const SHOW_VSCODE_ENV = 'ALV_E2E_SHOW_VSCODE';
const XVFB_ARGS = ['-a', '-s', '-screen 0 1280x1024x24'];

function shouldShowVsCode(env = process.env) {
  return /^(1|true)$/i.test(String(env[SHOW_VSCODE_ENV] || '').trim());
}

// Linux only. A run already under xvfb-run sets __ALV_XVFB_RAN so it is not wrapped twice.
// Without a DISPLAY there is nothing to show VS Code on, so Xvfb is used even when asked to show.
function shouldUseXvfb(env = process.env, platform = process.platform) {
  if (platform !== 'linux' || env.__ALV_XVFB_RAN) return false;
  return !env.DISPLAY || !shouldShowVsCode(env);
}

module.exports = { SHOW_VSCODE_ENV, XVFB_ARGS, shouldShowVsCode, shouldUseXvfb };

if (require.main === module) {
  // Used by the shell launchers: exit 0 when the run should show VS Code.
  process.exit(shouldShowVsCode() ? 0 : 1);
}
