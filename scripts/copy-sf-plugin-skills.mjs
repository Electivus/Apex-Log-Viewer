import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkillCatalog, readRegularTree } from './agent-skill-catalog.mjs';

export async function copySfPluginSkills(repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))) {
  const source = path.join(repoRoot, 'skills');
  const destination = path.join(repoRoot, 'packages/sf-plugin/skills');
  await readSkillCatalog(source);
  await readRegularTree(source);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true });
}

/** The Custom Logs reference ships from its repo sources, so the installed copy cannot drift from them. */
export const SF_PLUGIN_REFERENCE_FILES = [
  ['docs/CUSTOM_LOGS.md', 'CUSTOM_LOGS.md'],
  ['packages/core/schemas/sfdx-project.electivus.schema.json', 'sfdx-project.electivus.schema.json']
];

export async function copySfPluginReference(repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))) {
  const destination = path.join(repoRoot, 'packages/sf-plugin/reference');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const [from, to] of SF_PLUGIN_REFERENCE_FILES) {
    await fs.copyFile(path.join(repoRoot, from), path.join(destination, to));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copySfPluginSkills();
  await copySfPluginReference();
}
