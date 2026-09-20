import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function copySfPluginSkills(repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))) {
  const source = path.join(repoRoot, 'skills');
  const destination = path.join(repoRoot, 'packages/sf-plugin/skills');
  const skill = await fs.readFile(path.join(source, 'apex-log-viewer-cli/SKILL.md'), 'utf8');
  if (!/^---\r?\nname: apex-log-viewer-cli\r?\n/.test(skill)) throw new Error('Invalid bundled Apex Log Viewer skill.');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copySfPluginSkills();
}
