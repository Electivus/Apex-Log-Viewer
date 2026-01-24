const assert = require('assert');
const fs = require('fs');

const text = fs.readFileSync('.github/workflows/cli-npm-release.yml', 'utf8');
assert.ok(text.includes('cli-v*'));
assert.ok(text.includes('npm publish'));
assert.ok(text.includes('id-token: write'));
console.log('workflow ok');
