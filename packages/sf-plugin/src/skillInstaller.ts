import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillInstallResult = {
  status: 'installed' | 'replaced' | 'wouldInstall' | 'wouldReplace';
  skillName: string;
  codexHome: string;
  source: string;
  destination: string;
  files: string[];
  fileCount: number;
  replaced: boolean;
  dryRun: boolean;
};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(directory: string, root = directory): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(child, root)));
    else if (entry.isFile()) files.push(path.relative(root, child).split(path.sep).join('/'));
  }
  return files.sort();
}

async function bundledSkillDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..', 'skills', 'apex-log-viewer-cli'),
    path.resolve(moduleDirectory, '..', '..', '..', '.codex', 'skills', 'apex-log-viewer-cli'),
    path.resolve(process.cwd(), '.codex', 'skills', 'apex-log-viewer-cli')
  ];
  for (const candidate of candidates) if (await isDirectory(candidate)) return candidate;
  throw new Error('Bundled apex-log-viewer-cli Codex skill was not found.');
}

export async function installSkill(
  options: {
    codexHome?: string;
    dryRun?: boolean;
    force?: boolean;
  } = {}
): Promise<SkillInstallResult> {
  const source = await bundledSkillDirectory();
  const codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const destination = path.join(codexHome, 'skills', 'apex-log-viewer-cli');
  const alreadyExists = await exists(destination);
  const dryRun = options.dryRun === true;
  if (alreadyExists && !options.force && !dryRun) {
    throw new Error(`skill apex-log-viewer-cli already exists at ${destination}; rerun with --force to replace it`);
  }
  const files = await listFiles(source);
  if (!dryRun) {
    if (alreadyExists) await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
  }
  return {
    status: dryRun ? (alreadyExists ? 'wouldReplace' : 'wouldInstall') : alreadyExists ? 'replaced' : 'installed',
    skillName: 'apex-log-viewer-cli',
    codexHome,
    source,
    destination,
    files,
    fileCount: files.length,
    replaced: alreadyExists && !dryRun,
    dryRun
  };
}
