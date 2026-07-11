import type { DebugLevelWriteResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { debugLevelRecord, debugLevelValueFlags } from '../../../debugLevelFlags.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';

export default class DebugLevelUpdate extends AlvCommand<DebugLevelWriteResult> {
  public static override readonly summary = 'Update a debug level with explicit safety controls.';
  public static override readonly flags = {
    ...debugLevelValueFlags,
    'dry-run': dryRunFlag,
    id: Flags.string({ required: true, summary: 'Debug level id.' }),
    'target-org': targetOrgFlag,
    yes: yesFlag
  };

  public override async run(): Promise<DebugLevelWriteResult> {
    const { flags } = await this.parse(DebugLevelUpdate);
    return this.printResult(
      await core.debugLevel.update({
        confirmed: flags.yes,
        dryRun: flags['dry-run'],
        id: flags.id,
        record: debugLevelRecord(flags, flags.id),
        targetOrg: flags['target-org']
      })
    );
  }
}
