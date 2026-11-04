import type { TraceFlagRemoveResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { dryRunFlag, targetOrgFlag, traceFlagLogTypeFlag, yesFlag } from '../../../flags.js';
import { traceTarget } from '../../../traceTarget.js';

export default class TraceFlagRemove extends AlvCommand<TraceFlagRemoveResult> {
  public static override readonly summary = 'Remove trace flags with explicit safety controls.';
  public static override readonly description =
    'Deletes every trace flag of the chosen --log-type on the target, expired ones included, and leaves the other log type alone. ' +
    "The Developer Console uses the same DEVELOPER_LOG flag, so removing DEVELOPER_LOG also removes the Console's flag, and the Console creates it again when it opens.";
  public static override readonly flags = {
    'automated-process': Flags.boolean({ default: false, summary: 'Target Automated Process.' }),
    'current-user': Flags.boolean({ default: false, summary: 'Target the current org user.' }),
    'dry-run': dryRunFlag,
    'log-type': traceFlagLogTypeFlag,
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
        logType: flags['log-type'],
        target: traceTarget(flags),
        targetOrg: flags['target-org']
      })
    );
  }
}
