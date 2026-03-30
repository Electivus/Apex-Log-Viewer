const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('release docs mention the dedicated CLI workflow and pinned runtime metadata', () => {
  const ci = fs.readFileSync('docs/CI.md', 'utf8');
  const publishing = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
  const architecture = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  const plan = fs.readFileSync('docs/superpowers/plans/2026-03-29-independent-cli-release.md', 'utf8');

  assert.match(ci, /rust-release\.yml/);
  assert.match(ci, /NPM_TOKEN/);
  assert.doesNotMatch(ci, /CARGO_REGISTRY_TOKEN/);
  assert.match(publishing, /rust-vX\.Y\.Z/);
  assert.match(publishing, /npm native\/meta packages/i);
  assert.match(publishing, /crates\.io.*deferred/i);
  assert.match(architecture, /config\/runtime-bundle\.json/);
  assert.match(changelog, /independent Rust CLI release train/i);
  assert.match(plan, /cargo test -p apex-log-viewer-cli --test cli_smoke/);
  assert.doesNotMatch(plan, /cargo test -p alv-cli --test cli_smoke/);
});

test('test:scripts includes the release docs smoke test', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/docs-release\.test\.js\b/,
    'expected the release docs smoke test to run in the default script suite'
  );
});
