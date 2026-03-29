import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

type DependabotGroup = {
  patterns?: string[];
  'update-types'?: string[];
};

type ParsedDependabotUpdate = {
  'package-ecosystem'?: unknown;
  directory?: unknown;
  schedule?: unknown;
  'open-pull-requests-limit'?: unknown;
  groups?: unknown;
};

type ParsedDependabotConfig = {
  updates?: unknown;
};

function asStringArray(value: unknown, message: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  assert.ok(Array.isArray(value), message);
  value.forEach(entry => assert.equal(typeof entry, 'string', message));
  return value as string[];
}

function getUpdateConfig(raw: string, packageEcosystem: string, directory: string): ParsedDependabotUpdate {
  const config = parse(raw) as ParsedDependabotConfig;
  assert.ok(Array.isArray(config.updates), 'dependabot.yml should parse into an updates array');

  const update = config.updates.find((entry): entry is ParsedDependabotUpdate => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const typedUpdate = entry as ParsedDependabotUpdate;
    return typedUpdate['package-ecosystem'] === packageEcosystem && typedUpdate.directory === directory;
  });

  assert.ok(
    update,
    `dependabot.yml should define a ${packageEcosystem} updater for the ${directory === '/' ? 'repository root' : directory}`
  );

  return update;
}

function getNpmGroups(raw: string): Record<string, unknown> {
  const npmUpdate = getUpdateConfig(raw, 'npm', '/');
  assert.ok(
    npmUpdate.groups && typeof npmUpdate.groups === 'object' && !Array.isArray(npmUpdate.groups),
    'npm updater should define dependabot groups'
  );

  return npmUpdate.groups as Record<string, unknown>;
}

function getNpmGroupConfig(raw: string, groupName: string): DependabotGroup {
  const groups = getNpmGroups(raw);
  const group = groups[groupName];

  assert.ok(group && typeof group === 'object' && !Array.isArray(group), `npm dependabot group "${groupName}" should exist`);

  const typedGroup = group as Record<string, unknown>;

  return {
    patterns: asStringArray(typedGroup.patterns, `npm dependabot group "${groupName}" patterns should be a string array`),
    'update-types': asStringArray(
      typedGroup['update-types'],
      `npm dependabot group "${groupName}" update-types should be a string array`
    )
  };
}

suite('dependabot config', () => {
  test('reads groups from the npm updater instead of matching similarly indented YAML elsewhere', () => {
    const raw = `version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
  - package-ecosystem: 'github-actions'
    directory: '/'
    schedule:
      interval: 'weekly'
    groups:
      react:
        patterns:
          - 'react'
`;

    assert.throws(
      () => getNpmGroupConfig(raw, 'react'),
      /npm updater should define dependabot groups/i,
      'the helper should reject groups that only exist outside the npm updater'
    );
  });

  test('recognizes inline update-types syntax when checking whether majors stay grouped', () => {
    const raw = `version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
    groups:
      react:
        update-types: ['minor', 'patch']
        patterns:
          - 'react'
          - 'react-dom'
`;

    const reactGroup = getNpmGroupConfig(raw, 'react');

    assert.deepEqual(
      reactGroup['update-types'],
      ['minor', 'patch'],
      'inline update-types should be treated the same as block-style YAML when checking major grouping'
    );
  });

  test('groups tailwindcss plugins with the Tailwind toolchain', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const tailwindGroup = getNpmGroupConfig(raw, 'tailwind');

    assert.ok(tailwindGroup.patterns?.includes('tailwindcss'), 'tailwind group should include tailwindcss');
    assert.ok(tailwindGroup.patterns?.includes('@tailwindcss/*'), 'tailwind group should include @tailwindcss/*');
    assert.ok(
      tailwindGroup.patterns?.includes('tailwindcss-*'),
      'tailwind group should include tailwindcss-* so tailwindcss-animate stays grouped'
    );
    assert.equal(
      tailwindGroup['update-types'],
      undefined,
      'tailwind group should not exclude major updates because the CLI and core packages need to stay aligned'
    );
    assert.ok(
      !tailwindGroup.patterns?.includes('tailwind-*'),
      'tailwind group should not use the broader tailwind-* wildcard that catches unrelated packages'
    );
  });

  test('keeps React majors grouped for the lockstep runtime and type packages', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const reactGroup = getNpmGroupConfig(raw, 'react');

    assert.ok(reactGroup.patterns?.includes('react'), 'react group should include react');
    assert.ok(reactGroup.patterns?.includes('react-dom'), 'react group should include react-dom');
    assert.ok(reactGroup.patterns?.includes('@types/react'), 'react group should include @types/react');
    assert.ok(reactGroup.patterns?.includes('@types/react-dom'), 'react group should include @types/react-dom');
    assert.equal(
      reactGroup['update-types'],
      undefined,
      'react group should not exclude major updates because these packages move in lockstep'
    );
  });

  test('keeps TypeScript ESLint majors grouped for the coupled plugin and parser', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const typescriptEslintGroup = getNpmGroupConfig(raw, 'typescript-eslint');

    assert.ok(
      typescriptEslintGroup.patterns?.includes('@typescript-eslint/*'),
      'typescript-eslint group should include the full @typescript-eslint family'
    );
    assert.equal(
      typescriptEslintGroup['update-types'],
      undefined,
      'typescript-eslint group should not exclude major updates because plugin and parser majors are coupled'
    );
  });

  test('keeps Jest majors grouped with ts-jest and related test tooling', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const testingGroup = getNpmGroupConfig(raw, 'testing');

    assert.ok(testingGroup.patterns?.includes('jest'), 'testing group should include jest');
    assert.ok(testingGroup.patterns?.includes('jest-*'), 'testing group should include jest-*');
    assert.ok(
      testingGroup.patterns?.includes('jest-environment-*'),
      'testing group should include jest-environment-*'
    );
    assert.ok(testingGroup.patterns?.includes('ts-jest'), 'testing group should include ts-jest');
    assert.equal(
      testingGroup['update-types'],
      undefined,
      'testing group should not exclude major updates because Jest and ts-jest majors need to stay aligned'
    );
  });

  test('keeps Nx majors grouped for the coupled workspace plugins', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const nxGroup = getNpmGroupConfig(raw, 'nx');

    assert.ok(nxGroup.patterns?.includes('nx'), 'nx group should include nx');
    assert.ok(nxGroup.patterns?.includes('@nx/*'), 'nx group should include the @nx/* plugin family');
    assert.equal(
      nxGroup['update-types'],
      undefined,
      'nx group should not exclude major updates because nx and its plugins move together'
    );
  });

  test('defines a cargo updater at the workspace root for the Rust CLI stack', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    const cargoUpdate = getUpdateConfig(raw, 'cargo', '/');

    assert.deepEqual(
      cargoUpdate.schedule,
      { interval: 'weekly' },
      'cargo updater should check the workspace root weekly like the other ecosystems'
    );
    assert.equal(
      cargoUpdate['open-pull-requests-limit'],
      20,
      'cargo updater should use the same pull request limit as the other repository-level updaters'
    );
  });
});
