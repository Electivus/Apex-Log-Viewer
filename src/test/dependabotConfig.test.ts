import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

suite('dependabot config', () => {
  test('groups tailwindcss plugins with the Tailwind toolchain', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');

    assert.match(
      raw,
      /tailwind:\n(?: {6}.+\n)+ {8}patterns:\n(?: {10}- .+\n)+/,
      'dependabot tailwind group should remain present in .github/dependabot.yml'
    );
    assert.match(
      raw,
      /tailwind:\n[\s\S]*? {10}- 'tailwindcss-\*'/,
      'tailwind group should include tailwindcss-* so tailwindcss-animate stays grouped'
    );
    assert.doesNotMatch(
      raw,
      /tailwind:\n[\s\S]*? {10}- 'tailwind-\*'/,
      'tailwind group should not use the broader tailwind-* wildcard that catches unrelated packages'
    );
  });
});
