import type { TraceFlagRemoveResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';
import { traceTarget } from '../../../traceTarget.js';

export default class TraceFlagRemove extends AlvCommand<TraceFlagRemoveResult> {
  public static override readonly summary = 'Remove trace flags with explicit safety controls.';
  public static override readonly flags = {
    'automated-process': Flags.boolean({ default: false, summary: 'Target Automated Process.' }),
    'current-user': Flags.boolean({ default: false, summary: 'Target the current org user.' }),
    'dry-run': dryRunFlag,
    'platform-integration': Flags.boolean({ default: false, summary: 'Target Platform Integration.' }),
    'target-org': targetOrgFlag,
    'user-id': Flags.string({ summary: 'Target a Salesforce user id.' }),
    yes: yesFlag
  };

  public override async run(): Promise<TraceFlagRemoveResult> {
    const { flags } = await this.parse(TraceFlagRemove);
    return this.printResult(
      await core.traceFlag.remove({
        confirmed: flags.yes,
        dryRun: flags['dry-run'],
        target: traceTarget(flags),
        targetOrg: flags['target-org']
      })
    );
  }
}
