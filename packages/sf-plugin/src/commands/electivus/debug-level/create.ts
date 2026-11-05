import type { DebugLevelWriteResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { debugLevelFields, debugLevelValueFlags } from '../../../debugLevelFlags.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';

export default class DebugLevelCreate extends AlvCommand<DebugLevelWriteResult> {
  public static override readonly summary = 'Create a debug level with explicit safety controls.';
  public static override readonly description =
    'Omitted fields use defaults: language en_US, Apex Code and System DEBUG, every other category INFO, and the label equal to the developer name. Without --yes, the command previews the record and checks its picklist values against the org.';
  public static override readonly flags = {
    ...debugLevelValueFlags,
    'developer-name': Flags.string({ required: true, summary: 'Debug level developer name.' }),
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
        record: { ...debugLevelFields(flags), developerName: flags['developer-name'] },
        targetOrg: flags['target-org']
      })
    );
  }
}
