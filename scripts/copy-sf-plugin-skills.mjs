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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copySfPluginSkills();
}
