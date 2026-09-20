import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { dryRunFlag } from '../../../flags.js';
import { installSkill, type SkillInstallResult } from '../../../skillInstaller.js';
import { promptForSkillAgents } from '../../../skillPrompt.js';
import { agentIds, detectSkillAgents, skillEnvironment } from '../../../skillTargets.js';

export default class SkillInstall extends AlvCommand<SkillInstallResult> {
  public static override readonly summary = 'Install the bundled Apex Log Viewer Agent Skill without network access.';
  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --agent codex --agent claude-code',
    '<%= config.bin %> <%= command.id %> --agent codex --global --force --json',
    '<%= config.bin %> <%= command.id %> --skills-dir ./custom-skills --dry-run'
  ];
  public static override readonly flags = {
    agent: Flags.string({
      summary: 'Agent to install for; repeat to select several.',
      options: [...agentIds],
      multiple: true
    }),
    global: Flags.boolean({
      summary: 'Install in the user profile instead of the current project.',
      default: false,
      exclusive: ['workspace-root']
    }),
    'workspace-root': Flags.directory({
      summary: 'Project directory; defaults to the current directory.',
      exists: true
    }),
    'skills-dir': Flags.string({
      summary: 'Custom parent directory for the skill.',
      exclusive: ['agent', 'global', 'workspace-root', 'codex-home']
    }),
    'codex-home': Flags.string({
      summary: 'Legacy Codex home; prefer --agent codex --global.',
      deprecated: true,
      exclusive: ['agent', 'global', 'workspace-root', 'skills-dir']
    }),
    'dry-run': dryRunFlag,
    force: Flags.boolean({ summary: 'Replace different existing skill content.', default: false })
  };

  public override async run(): Promise<SkillInstallResult> {
    const { flags } = await this.parse(SkillInstall);
    let agents = flags.agent;
    if (!agents?.length && flags['skills-dir'] === undefined && flags['codex-home'] === undefined) {
      if (this.jsonEnabled() || process.env.CI || !process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error('Specify --agent or --skills-dir in non-interactive mode.');
      }
      const environment = skillEnvironment();
      if (flags['workspace-root']) environment.cwd = flags['workspace-root'];
      agents = await promptForSkillAgents(await detectSkillAgents(environment));
    }
    return this.printResult(
      await installSkill({
        agents,
        global: flags.global,
        workspaceRoot: flags['workspace-root'],
        skillsDir: flags['skills-dir'],
        codexHome: flags['codex-home'],
        dryRun: flags['dry-run'],
        force: flags.force
      })
    );
  }
}
