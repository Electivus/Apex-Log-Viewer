import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function getGroupBlock(raw: string, groupName: string): string {
  const start = raw.indexOf(`      ${groupName}:\n`);
  assert.notEqual(start, -1, `dependabot group "${groupName}" should exist`);

  const rest = raw.slice(start + 1);
  const nextGroup = rest.match(/\n(?: {6}[a-z0-9-]+:\n| {4}ignore:\n| {2}- package-ecosystem:)/);
  const end = nextGroup?.index;
  return end === undefined ? raw.slice(start) : raw.slice(start, start + 1 + end);
}

suite('dependabot config', () => {
  test('groups tailwindcss plugins with the Tailwind toolchain', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const tailwindGroup = getGroupBlock(raw, 'tailwind');

    assert.match(tailwindGroup, / {10}- 'tailwindcss'/, 'tailwind group should include tailwindcss');
    assert.match(tailwindGroup, / {10}- '@tailwindcss\/\*'/, 'tailwind group should include @tailwindcss/*');
    assert.match(
      tailwindGroup,
      / {10}- 'tailwindcss-\*'/,
      'tailwind group should include tailwindcss-* so tailwindcss-animate stays grouped'
    );
    assert.doesNotMatch(
      tailwindGroup,
      / {8}update-types:\n(?: {10}- .+\n)+/,
      'tailwind group should not exclude major updates because the CLI and core packages need to stay aligned'
    );
    assert.doesNotMatch(
      tailwindGroup,
      / {10}- 'tailwind-\*'/,
      'tailwind group should not use the broader tailwind-* wildcard that catches unrelated packages'
    );
  });

  test('keeps React majors grouped for the lockstep runtime and type packages', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const reactGroup = getGroupBlock(raw, 'react');

    assert.match(reactGroup, / {10}- 'react'/, 'react group should include react');
    assert.match(reactGroup, / {10}- 'react-dom'/, 'react group should include react-dom');
    assert.match(reactGroup, / {10}- '@types\/react'/, 'react group should include @types/react');
    assert.match(reactGroup, / {10}- '@types\/react-dom'/, 'react group should include @types/react-dom');
    assert.doesNotMatch(
      reactGroup,
      / {8}update-types:\n(?: {10}- .+\n)+/,
      'react group should not exclude major updates because these packages move in lockstep'
    );
  });

  test('keeps TypeScript ESLint majors grouped for the coupled plugin and parser', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const typescriptEslintGroup = getGroupBlock(raw, 'typescript-eslint');

    assert.match(
      typescriptEslintGroup,
      / {10}- '@typescript-eslint\/\*'/,
      'typescript-eslint group should include the full @typescript-eslint family'
    );
    assert.doesNotMatch(
      typescriptEslintGroup,
      / {8}update-types:\n(?: {10}- .+\n)+/,
      'typescript-eslint group should not exclude major updates because plugin and parser majors are coupled'
    );
  });

  test('keeps Jest majors grouped with ts-jest and related test tooling', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const testingGroup = getGroupBlock(raw, 'testing');

    assert.match(testingGroup, / {10}- 'jest'/, 'testing group should include jest');
    assert.match(testingGroup, / {10}- 'jest-\*'/, 'testing group should include jest-*');
    assert.match(
      testingGroup,
      / {10}- 'jest-environment-\*'/,
      'testing group should include jest-environment-*'
    );
    assert.match(testingGroup, / {10}- 'ts-jest'/, 'testing group should include ts-jest');
    assert.doesNotMatch(
      testingGroup,
      / {8}update-types:\n(?: {10}- .+\n)+/,
      'testing group should not exclude major updates because Jest and ts-jest majors need to stay aligned'
    );
  });
});
