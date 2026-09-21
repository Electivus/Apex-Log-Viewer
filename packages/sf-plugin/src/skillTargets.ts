import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const skillName = 'apex-log-viewer-cli';
export const skillNames = [skillName, 'apex-debug-investigate', 'apex-debug-performance'] as const;
export const agentIds = ['claude-code', 'codex', 'github-copilot', 'devin'] as const;
export type SkillAgent = (typeof agentIds)[number];
export type SkillScope = 'project' | 'global' | 'custom';
export type SkillTarget = { agents: SkillAgent[]; scope: SkillScope; destination: string };
export type SkillInstallOptions = {
  skills?: string[];
  all?: boolean;
  agents?: string[];
  global?: boolean;
  workspaceRoot?: string;
  skillsDir?: string;
  codexHome?: string;
  dryRun?: boolean;
  force?: boolean;
};
export type SkillEnvironment = { cwd: string; home: string; env: NodeJS.ProcessEnv };

export function skillEnvironment(): SkillEnvironment {
  return { cwd: process.cwd(), home: os.homedir(), env: process.env };
}

export function agentDirectories(context: SkillEnvironment) {
  const configured = (key: string, fallback: string) => context.env[key]?.trim() || fallback;
  return {
    'claude-code': {
      project: '.claude/skills',
      global: path.join(configured('CLAUDE_CONFIG_DIR', path.join(context.home, '.claude')), 'skills')
    },
    codex: {
      project: '.agents/skills',
      global: path.join(configured('CODEX_HOME', path.join(context.home, '.codex')), 'skills')
    },
    'github-copilot': { project: '.agents/skills', global: path.join(context.home, '.copilot/skills') },
    devin: {
      project: '.devin/skills',
      global: path.join(configured('XDG_CONFIG_HOME', path.join(context.home, '.config')), 'devin/skills')
    }
  };
}

export async function detectSkillAgents(context = skillEnvironment()): Promise<SkillAgent[]> {
  const directories = agentDirectories(context);
  const detected: SkillAgent[] = [];
  for (const agent of agentIds) {
    // A shared .agents folder alone does not identify Codex or Copilot.
    const candidates = [path.dirname(directories[agent].global)];
    if (agent === 'claude-code' || agent === 'devin') {
      candidates.push(path.resolve(context.cwd, path.dirname(directories[agent].project)));
    }
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isDirectory()) {
          detected.push(agent);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return detected;
}

export function selectedSkillNames(options: SkillInstallOptions): string[] {
  if (options.all && options.skills !== undefined) throw new Error('--all and --skill are mutually exclusive.');
  if (options.skills !== undefined && options.skills.length === 0) throw new Error('Select at least one skill.');
  const selected = options.all ? [...skillNames] : (options.skills ?? [skillName]);
  for (const name of selected) {
    if (!(skillNames as readonly string[]).includes(name)) throw new Error(`Unsupported skill: ${name}.`);
  }
  return [...new Set(selected)];
}

export function resolveSkillTargets(
  options: SkillInstallOptions,
  context = skillEnvironment(),
  selectedSkill = skillName
): SkillTarget[] {
  selectedSkillNames({ skills: [selectedSkill] });
  const explicitScope = options.global || options.workspaceRoot !== undefined;
  if (options.global && options.workspaceRoot !== undefined) {
    throw new Error('--global and --workspace-root are mutually exclusive.');
  }
  if (options.skillsDir !== undefined || options.codexHome !== undefined) {
    if (
      options.agents?.length ||
      explicitScope ||
      (options.skillsDir !== undefined && options.codexHome !== undefined)
    ) {
      throw new Error('--skills-dir and --codex-home cannot be combined with agent or scope flags.');
    }
    const directory = options.skillsDir ?? options.codexHome;
    if (!directory?.trim()) throw new Error('The destination directory must not be empty.');
    return [
      {
        agents: options.codexHome !== undefined ? ['codex'] : [],
        scope: options.codexHome !== undefined ? 'global' : 'custom',
        destination: path.resolve(
          context.cwd,
          directory,
          ...(options.codexHome !== undefined ? ['skills'] : []),
          selectedSkill
        )
      }
    ];
  }
  if (!options.agents?.length) throw new Error('Specify --agent or --skills-dir in non-interactive mode.');
  const directories = agentDirectories(context);
  const targets = new Map<string, SkillTarget>();
  for (const value of options.agents) {
    if (!agentIds.includes(value as SkillAgent)) throw new Error(`Unsupported agent: ${value}.`);
    const agent = value as SkillAgent;
    const destination = options.global
      ? path.resolve(context.cwd, directories[agent].global, selectedSkill)
      : path.resolve(context.cwd, options.workspaceRoot ?? '.', directories[agent].project, selectedSkill);
    const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
    const existing = targets.get(key);
    if (existing) {
      if (!existing.agents.includes(agent)) existing.agents.push(agent);
    } else {
      targets.set(key, { agents: [agent], scope: options.global ? 'global' : 'project', destination });
    }
  }
  return [...targets.values()];
}
