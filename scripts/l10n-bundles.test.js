const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { baseFile, buildBundles, collectMessages, ptBrFile } = require('./gen-l10n.cjs');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const placeholders = text => (text.match(/\{\d+\}/g) || []).sort();

test('every runtime message has a pt-BR translation', () => {
  const { untranslated } = buildBundles();
  assert.deepEqual(
    untranslated.map(({ legacyKey, location }) => `${legacyKey} (${location})`),
    [],
    'add the missing entries to ptBrByLegacyKey in scripts/gen-l10n.cjs, or to sameInPtBr if the text is the same in pt-BR, then run pnpm run l10n:write'
  );
});

test('the committed l10n bundles match the localize calls', () => {
  const { baseBundle, ptBrBundle } = buildBundles(collectMessages(), readJson(ptBrFile));
  assert.deepEqual(readJson(baseFile), baseBundle, 'run pnpm run l10n:write and commit apps/vscode-extension/l10n');
  assert.deepEqual(readJson(ptBrFile), ptBrBundle, 'run pnpm run l10n:write and commit apps/vscode-extension/l10n');
});

test('pt-BR translations keep the placeholders of the English message', () => {
  for (const [message, translated] of Object.entries(readJson(ptBrFile))) {
    assert.deepEqual(placeholders(translated), placeholders(message), message);
  }
});
