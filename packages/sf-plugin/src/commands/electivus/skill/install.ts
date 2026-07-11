import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { dryRunFlag } from '../../../flags.js';
import { installSkill, type SkillInstallResult } from '../../../skillInstaller.js';

export default class SkillInstall extends AlvCommand<SkillInstallResult> {
  public static override readonly summary = 'Install the bundled Apex Log Viewer Codex skill.';
  public static override readonly flags = {
    'codex-home': Flags.directory({ summary: 'Codex home directory.' }),
    'dry-run': dryRunFlag,
    force: Flags.boolean({ default: false, summary: 'Replace an existing skill installation.' })
  };

  public override async run(): Promise<SkillInstallResult> {
    const { flags } = await this.parse(SkillInstall);
    return this.printResult(
      await installSkill({ codexHome: flags['codex-home'], dryRun: flags['dry-run'], force: flags.force })
    );
  }
}
