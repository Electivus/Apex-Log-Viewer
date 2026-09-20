import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSkillTargets,
  skillName,
  type SkillEnvironment,
  type SkillInstallOptions,
  type SkillTarget
} from './skillTargets.js';

type FileSystem = Pick<typeof fs, 'lstat' | 'readdir' | 'readFile' | 'mkdir' | 'mkdtemp' | 'cp' | 'rename' | 'rm'>;
export type SkillInstallation = SkillTarget & {
  status: 'installed' | 'replaced' | 'unchanged' | 'wouldInstall' | 'wouldReplace';
};
export type SkillInstallResult = {
  skillName: string;
  pluginVersion: string;
  source: string;
  files: string[];
  dryRun: boolean;
  installations: SkillInstallation[];
};

async function statIfPresent(target: string, io: FileSystem) {
  try {
    return await io.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ordinaryDirectory(target: string, io: FileSystem): Promise<boolean> {
  const stat = await statIfPresent(target, io);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Refusing non-directory or symlink/junction destination: ${target}`);
  }
  return Boolean(stat);
}

async function readTree(directory: string, io: FileSystem, prefix = ''): Promise<Map<string, Buffer>> {
  await ordinaryDirectory(directory, io);
  const files = new Map<string, Buffer>();
  for (const entry of await io.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, contents] of await readTree(child, io, `${relative}/`)) files.set(name, contents);
    } else if (entry.isFile()) files.set(relative, await io.readFile(child));
    else throw new Error(`Refusing symlink or special file in skill: ${child}`);
  }
  return files;
}

async function replaceSkill(source: string, destination: string, replace: boolean, io: FileSystem) {
  const parent = path.dirname(destination);
  await io.mkdir(parent, { recursive: true });
  const temporary = await io.mkdtemp(path.join(parent, '.alv-skill-'));
  const staged = path.join(temporary, 'new');
  const backup = path.join(temporary, 'previous');
  let safeToClean = true;
  try {
    await io.cp(source, staged, { recursive: true, dereference: false });
    const exists = await ordinaryDirectory(destination, io);
    if (exists !== replace) throw new Error(`Destination changed during installation; retry: ${destination}`);
    if (replace) await io.rename(destination, backup);
    try {
      await io.rename(staged, destination);
    } catch (error) {
      if (replace) {
        safeToClean = false;
        try {
          await io.rename(backup, destination);
          safeToClean = true;
        } catch {
          throw new Error(
            `Installation failed; the previous skill is preserved at ${backup}. Restore it before retrying.`,
            { cause: error }
          );
        }
      }
      throw error;
    }
  } finally {
    if (safeToClean) await io.rm(temporary, { recursive: true, force: true });
  }
}

export async function installSkill(
  options: SkillInstallOptions,
  dependencies: { packageRoot?: string; environment?: SkillEnvironment; io?: FileSystem } = {}
): Promise<SkillInstallResult> {
  const io = dependencies.io ?? fs;
  const packageRoot = dependencies.packageRoot ?? fileURLToPath(new URL('../', import.meta.url));
  const source = path.join(packageRoot, 'skills', skillName);
  const targets = resolveSkillTargets(options, dependencies.environment);
  const manifest = JSON.parse(await io.readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  if (!(await ordinaryDirectory(source, io)))
    throw new Error('Bundled skill is missing; reinstall the plugin from your npm registry.');
  const files = await readTree(source, io);
  if (
    !files
      .get('SKILL.md')
      ?.toString('utf8')
      .match(/^---\r?\nname: apex-log-viewer-cli\r?\n/)
  ) {
    throw new Error('Bundled apex-log-viewer-cli/SKILL.md is missing or invalid.');
  }
  const installations: SkillInstallation[] = [];
  // Validate every destination before making any change.
  for (const target of targets) {
    const relative = path.relative(source, target.destination);
    const inverse = path.relative(target.destination, source);
    if (
      (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
      (!inverse.startsWith(`..${path.sep}`) && !path.isAbsolute(inverse))
    ) {
      throw new Error('The installation destination must not overlap the bundled skill.');
    }
    await ordinaryDirectory(path.dirname(target.destination), io);
    const exists = await ordinaryDirectory(target.destination, io);
    const previous = exists ? await readTree(target.destination, io) : new Map<string, Buffer>();
    const identical =
      exists &&
      previous.size === files.size &&
      [...files].every(([name, content]) => previous.get(name)?.equals(content));
    if (exists && !identical && !options.force) {
      throw new Error(
        `Skill already exists at ${target.destination}; use --force to replace it (also required for --dry-run).`
      );
    }
    installations.push({ ...target, status: identical ? 'unchanged' : exists ? 'wouldReplace' : 'wouldInstall' });
  }
  const completed: string[] = [];
  if (!options.dryRun) {
    for (const installation of installations) {
      if (installation.status === 'unchanged') continue;
      try {
        await replaceSkill(source, installation.destination, installation.status === 'wouldReplace', io);
      } catch (error) {
        throw new Error(
          `Skill installation failed at ${installation.destination}. Completed destinations: ${completed.join(', ') || 'none'}. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      installation.status = installation.status === 'wouldReplace' ? 'replaced' : 'installed';
      completed.push(installation.destination);
    }
  }
  return {
    skillName,
    pluginVersion: manifest.version,
    source,
    files: [...files.keys()].sort(),
    dryRun: options.dryRun === true,
    installations
  };
}
