import type { DebugLevelWriteResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';

export default class DebugLevelDelete extends AlvCommand<DebugLevelWriteResult> {
  public static override readonly summary = 'Delete a debug level with explicit safety controls.';
  public static override readonly flags = {
    'dry-run': dryRunFlag,
    id: Flags.string({ required: true, summary: 'Debug level id.' }),
    'target-org': targetOrgFlag,
    yes: yesFlag
  };

  public override async run(): Promise<DebugLevelWriteResult> {
    const { flags } = await this.parse(DebugLevelDelete);
    return this.printResult(
      await core.debugLevel.delete({
        confirmed: flags.yes,
        dryRun: flags['dry-run'],
        id: flags.id,
        targetOrg: flags['target-org']
      })
    );
  }
}
