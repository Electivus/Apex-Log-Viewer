const assert = require('assert');
const fs = require('fs');

const ci = fs.readFileSync('docs/CI.md', 'utf8');
const pub = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
assert.ok(ci.includes('cli-v'));
assert.ok(pub.includes('NPM_TOKEN'));
console.log('docs ok');
