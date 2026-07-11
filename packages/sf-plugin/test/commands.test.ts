import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const commandsRoot = path.resolve(testDirectory, '..', 'src', 'commands', 'electivus');

async function commandFiles(directory: string, prefix = 'electivus'): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await commandFiles(child, `${prefix}:${entry.name}`)));
    else if (entry.name.endsWith('.ts')) result.push(`${prefix}:${entry.name.slice(0, -3)}`);
  }
  return result.sort();
}

test('plugin exposes class-per-command singular taxonomy', async () => {
  assert.deepEqual(await commandFiles(commandsRoot), [
    'electivus:debug-level:create',
    'electivus:debug-level:delete',
    'electivus:debug-level:get',
    'electivus:debug-level:list',
    'electivus:debug-level:update',
    'electivus:doctor',
    'electivus:log:delete',
    'electivus:log:list',
    'electivus:log:read',
    'electivus:log:resolve',
    'electivus:log:status',
    'electivus:log:sync',
    'electivus:log:triage',
    'electivus:org:list',
    'electivus:org:resolve',
    'electivus:skill:install',
    'electivus:tooling:get',
    'electivus:tooling:query',
    'electivus:trace-flag:apply',
    'electivus:trace-flag:remove',
    'electivus:trace-flag:status',
    'electivus:user:search'
  ]);
});
