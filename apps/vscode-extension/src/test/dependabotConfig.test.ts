import assert from 'assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

type ParsedDependabotUpdate = {
  'package-ecosystem'?: unknown;
  groups?: unknown;
};

type ParsedDependabotConfig = {
  updates?: unknown;
};

async function readDependabotUpdates(): Promise<ParsedDependabotUpdate[]> {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const raw = await readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
  const config = parse(raw) as ParsedDependabotConfig;
  assert.ok(Array.isArray(config.updates), 'dependabot.yml should parse into an updates array');

  return config.updates.filter((entry): entry is ParsedDependabotUpdate => Boolean(entry) && typeof entry === 'object');
}

suite('dependabot config', () => {
  test('does not group dependency updates', async () => {
    const updates = await readDependabotUpdates();

    assert.deepEqual(
      updates.filter(update => update.groups !== undefined).map(update => update['package-ecosystem']),
      [],
      'dependabot updaters should open one pull request per dependency'
    );
  });

  test('does not define a cargo updater after removing the native runtime stack', async () => {
    const updates = await readDependabotUpdates();

    assert.deepEqual(
      updates.filter(update => update['package-ecosystem'] === 'cargo'),
      [],
      'cargo updater should not be configured when no Cargo workspace remains'
    );
  });
});
