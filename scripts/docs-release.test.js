const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('release docs mention the dedicated CLI workflow and pinned runtime metadata', () => {
  const ci = fs.readFileSync('docs/CI.md', 'utf8');
  const publishing = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
  const architecture = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');

  assert.match(ci, /rust-release\.yml/);
  assert.match(ci, /CARGO_REGISTRY_TOKEN/);
  assert.match(publishing, /rust-vX\.Y\.Z/);
  assert.match(architecture, /config\/runtime-bundle\.json/);
  assert.match(changelog, /independent Rust CLI release train/i);
});

test('test:scripts includes the release docs smoke test', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/docs-release\.test\.js\b/,
    'expected the release docs smoke test to run in the default script suite'
  );
});
