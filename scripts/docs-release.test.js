const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('release docs describe the independent core and plugin packaging model', () => {
  const ci = fs.readFileSync('docs/CI.md', 'utf8');
  const publishing = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
  const architecture = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');

  assert.match(ci, /pnpm run build/);
  assert.match(ci, /test:sf-plugin/);
  assert.doesNotMatch(ci, /build:embedded-sf-plugin/);
  assert.doesNotMatch(ci, /NPM_TOKEN/);
  assert.match(publishing, /plugin npm release/i);
  assert.match(publishing, /sf-plugin-vX\.Y\.Z/);
  assert.match(publishing, /sf-plugin-release\.yml/);
  assert.match(publishing, /Trusted Publishing\/OIDC/);
  assert.doesNotMatch(publishing, /rust-release\.yml/);
  assert.match(architecture, /@alv\/core/);
  assert.match(architecture, /in-process/i);
  assert.doesNotMatch(architecture, /electivus-runner\.cjs/);
  assert.match(changelog, /shared TypeScript core/i);
});

test('README screenshot assets point at the published extension media paths', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const assetPaths = [
    'apps/vscode-extension/media/banner.png',
    'apps/vscode-extension/media/docs/hero.png',
    'apps/vscode-extension/media/docs/log-viewer.png',
    'apps/vscode-extension/media/docs/debug-flags.png',
    'apps/vscode-extension/media/docs/tail.png'
  ];

  for (const assetPath of assetPaths) {
    assert.equal(fs.existsSync(assetPath), true, `expected ${assetPath} to exist`);
    assert.match(readme, new RegExp(escapeRegExp(assetPath)));
  }

  assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/Electivus\/Apex-Log-Viewer\/main\/media\//);
  assert.doesNotMatch(readme, /!\[[^\]]*\]\(media\//);
});

test('test:scripts includes the release docs smoke test', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/docs-release\.test\.js\b/,
    'expected the release docs smoke test to run in the default script suite'
  );
});
