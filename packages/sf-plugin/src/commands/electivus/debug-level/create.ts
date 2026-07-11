import type { DebugLevelWriteResult } from '@alv/core/contracts';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { debugLevelRecord, debugLevelValueFlags } from '../../../debugLevelFlags.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';

export default class DebugLevelCreate extends AlvCommand<DebugLevelWriteResult> {
  public static override readonly summary = 'Create a debug level with explicit safety controls.';
  public static override readonly flags = {
    ...debugLevelValueFlags,
    'dry-run': dryRunFlag,
    'target-org': targetOrgFlag,
    yes: yesFlag
  };

  public override async run(): Promise<DebugLevelWriteResult> {
    const { flags } = await this.parse(DebugLevelCreate);
    return this.printResult(
      await core.debugLevel.create({
        confirmed: flags.yes,
        dryRun: flags['dry-run'],
        record: debugLevelRecord(flags),
        targetOrg: flags['target-org']
      })
    );
  }
}
