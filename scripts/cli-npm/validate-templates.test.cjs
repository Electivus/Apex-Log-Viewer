const assert = require('assert');
const path = require('path');

const wrapperPkg = require(path.resolve('crates/cli/npm/wrapper/package.json'));
const platformPkg = require(path.resolve('crates/cli/npm/platform/package.json'));

assert.ok(wrapperPkg.name === '@electivus/apex-log-viewer-cli');
assert.ok(wrapperPkg.bin && wrapperPkg.bin['apex-log-viewer']);
assert.ok(Array.isArray(wrapperPkg.files));

assert.ok(platformPkg.name.includes('@electivus/apex-log-viewer-cli-'));
assert.ok(Array.isArray(platformPkg.files));
assert.ok(platformPkg.os && platformPkg.cpu);

console.log('templates ok');
