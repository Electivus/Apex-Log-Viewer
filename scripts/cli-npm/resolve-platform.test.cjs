const assert = require('assert');
const { resolvePlatform } = require('../../crates/cli/npm/wrapper/lib/resolve-platform.cjs');

assert.deepStrictEqual(resolvePlatform('linux', 'x64'), {
  packageName: '@electivus/apex-log-viewer-cli-linux-x64',
  binName: 'apex-log-viewer'
});
assert.deepStrictEqual(resolvePlatform('darwin', 'arm64'), {
  packageName: '@electivus/apex-log-viewer-cli-darwin-arm64',
  binName: 'apex-log-viewer'
});
assert.deepStrictEqual(resolvePlatform('win32', 'x64'), {
  packageName: '@electivus/apex-log-viewer-cli-win32-x64',
  binName: 'apex-log-viewer.exe'
});
assert.throws(() => resolvePlatform('freebsd', 'x64'));
console.log('resolve-platform ok');
