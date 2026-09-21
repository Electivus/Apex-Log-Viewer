import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSkillTargets,
  skillEnvironment,
  skillName,
  selectedSkillNames,
  type SkillEnvironment,
  type SkillInstallOptions,
  type SkillTarget
} from './skillTargets.js';

type FileSystem = Pick<typeof fs, 'lstat' | 'readdir' | 'readFile' | 'mkdir' | 'mkdtemp' | 'cp' | 'rename' | 'rm'>;
export type SkillInstallation = SkillTarget & {
  status: 'installed' | 'replaced' | 'unchanged' | 'wouldInstall' | 'wouldReplace';
  warnings?: string[];
};
export type SkillInstallResult = {
  skillName: string;
  pluginVersion: string;
  source: string;
  files: string[];
  dryRun: boolean;
  installations: SkillInstallation[];
};
export type SkillsInstallResult = {
  pluginVersion: string;
  dryRun: boolean;
  skills: SkillInstallResult[];
};
type InstallDependencies = { packageRoot?: string; environment?: SkillEnvironment; io?: FileSystem };

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

function insideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function destinationRoot(target: SkillTarget, options: SkillInstallOptions, environment: SkillEnvironment): string {
  if (target.scope === 'project') return path.resolve(environment.cwd, options.workspaceRoot ?? '.');
  if (target.scope === 'global' && insideDirectory(environment.home, target.destination)) return environment.home;
  if (target.scope === 'global' && target.agents.includes('devin')) {
    // XDG_CONFIG_HOME is explicit; the appended devin directory is not.
    return path.resolve(
      environment.cwd,
      environment.env.XDG_CONFIG_HOME?.trim() || path.join(environment.home, '.config')
    );
  }
  // Outside the profile, the caller explicitly selected the custom/configuration root.
  return path.dirname(path.dirname(target.destination));
}

async function validateAncestors(destination: string, root: string, io: FileSystem): Promise<void> {
  // Trust the explicitly chosen root, including OS aliases such as macOS /var.
  // Every component below it must be an ordinary directory, never a redirect.
  for (let directory = path.dirname(destination); directory !== root; directory = path.dirname(directory)) {
    await ordinaryDirectory(directory, io);
    if (directory === path.dirname(directory)) throw new Error('Invalid skill destination root.');
  }
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

async function replaceSkill(source: string, destination: string, root: string, replace: boolean, io: FileSystem) {
  await validateAncestors(destination, root, io);
  const parent = path.dirname(destination);
  await io.mkdir(parent, { recursive: true });
  const temporary = await io.mkdtemp(path.join(parent, '.alv-skill-'));
  const staged = path.join(temporary, 'new');
  const backup = path.join(temporary, 'previous');
  let safeToClean = true;
  let failure: Error | undefined;
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
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  let warning: string | undefined;
  if (safeToClean) {
    try {
      await io.rm(temporary, { recursive: true, force: true });
    } catch (error) {
      const message = `Could not clean temporary skill directory ${temporary}: ${error instanceof Error ? error.message : String(error)}`;
      if (failure) failure = new AggregateError([failure, error], `${failure.message}. ${message}`);
      else warning = message;
    }
  }
  if (failure) throw failure;
  return warning;
}

async function prepareSkill(
  options: SkillInstallOptions,
  dependencies: InstallDependencies,
  selectedSkill: string
): Promise<SkillInstallResult> {
  const io = dependencies.io ?? fs;
  const packageRoot = dependencies.packageRoot ?? fileURLToPath(new URL('../', import.meta.url));
  const bundleRoot = path.join(packageRoot, 'skills');
  const source = path.join(bundleRoot, selectedSkill);
  const environment = dependencies.environment ?? skillEnvironment();
  const targets = resolveSkillTargets(options, environment, selectedSkill);
  const manifest = JSON.parse(await io.readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  if (!(await ordinaryDirectory(source, io)))
    throw new Error('Bundled skill is missing; reinstall the plugin from your npm registry.');
  const files = await readTree(source, io);
  if (
    !files.get('SKILL.md')?.toString('utf8').startsWith(`---\nname: ${selectedSkill}\n`) &&
    !files.get('SKILL.md')?.toString('utf8').startsWith(`---\r\nname: ${selectedSkill}\r\n`)
  ) {
    throw new Error(`Bundled ${selectedSkill}/SKILL.md is missing or invalid.`);
  }
  const installations: SkillInstallation[] = [];
  // Validate every destination before making any change.
  for (const target of targets) {
    if (insideDirectory(bundleRoot, target.destination) || insideDirectory(target.destination, bundleRoot)) {
      throw new Error('The installation destination must not overlap the bundled skill.');
    }
    await validateAncestors(target.destination, destinationRoot(target, options, environment), io);
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
  return {
    skillName: selectedSkill,
    pluginVersion: manifest.version,
    source,
    files: [...files.keys()].sort(),
    dryRun: options.dryRun === true,
    installations
  };
}

async function writeSkills(
  results: SkillInstallResult[],
  options: SkillInstallOptions,
  dependencies: InstallDependencies
) {
  const io = dependencies.io ?? fs;
  const environment = dependencies.environment ?? skillEnvironment();
  const completed: string[] = [];
  if (!options.dryRun) {
    for (const result of results) {
      for (const installation of result.installations) {
        if (installation.status === 'unchanged') continue;
        try {
          const warning = await replaceSkill(
            result.source,
            installation.destination,
            destinationRoot(installation, options, environment),
            installation.status === 'wouldReplace',
            io
          );
          if (warning) installation.warnings = [warning];
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
  }
}

// The legacy API and command response stay unchanged without an explicit selection.
export async function installSkill(
  options: SkillInstallOptions,
  dependencies: InstallDependencies = {}
): Promise<SkillInstallResult> {
  const result = await prepareSkill(options, dependencies, skillName);
  await writeSkills([result], options, dependencies);
  return result;
}

export async function installSkills(
  options: SkillInstallOptions,
  dependencies: InstallDependencies = {}
): Promise<SkillInstallResult | SkillsInstallResult> {
  const selected = selectedSkillNames(options);
  if (!options.all && options.skills === undefined) return installSkill(options, dependencies);
  const results: SkillInstallResult[] = [];
  // Preflight every skill and destination before writing any of them.
  for (const name of selected) results.push(await prepareSkill(options, dependencies, name));
  await writeSkills(results, options, dependencies);
  return { pluginVersion: results[0]!.pluginVersion, dryRun: options.dryRun === true, skills: results };
}
