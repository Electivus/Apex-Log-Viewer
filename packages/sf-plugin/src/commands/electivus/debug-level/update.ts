import type { DebugLevelWriteResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { debugLevelFields, debugLevelValueFlags } from '../../../debugLevelFlags.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';

export default class DebugLevelUpdate extends AlvCommand<DebugLevelWriteResult> {
  public static override readonly summary = 'Update a debug level with explicit safety controls.';
  public static override readonly description =
    'Changes only the fields you pass. Every other field keeps its current value. Without --yes, the command previews the resulting record and checks the passed picklist values against the org.';
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
        changes: debugLevelFields(flags),
        targetOrg: flags['target-org']
      })
    );
  }
}
