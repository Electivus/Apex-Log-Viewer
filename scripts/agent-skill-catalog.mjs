import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export async function readSkillCatalog(root) {
  const names = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`Unexpected skill catalog entry: ${entry.name}`);
    }
    const content = await fs.readFile(path.join(root, entry.name, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    const metadata = frontmatter && parse(frontmatter[1]);
    if (metadata?.name !== entry.name || typeof metadata.description !== 'string' || !metadata.description.trim()) {
      throw new Error(`Invalid bundled skill: ${entry.name}`);
    }
    names.push(entry.name);
  }
  if (!names.length) throw new Error('Empty skill catalog.');
  return names.sort();
}

export async function readRegularTree(root, prefix = '') {
  if (!(await fs.lstat(root)).isDirectory()) throw new Error(`Not a real directory: ${root}`);
  const files = new Map();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [child, body] of await readRegularTree(absolute, `${name}/`)) files.set(child, body);
    } else if (entry.isFile()) files.set(name, await fs.readFile(absolute));
    else throw new Error(`Refusing symlink or special file: ${absolute}`);
  }
  return files;
}
