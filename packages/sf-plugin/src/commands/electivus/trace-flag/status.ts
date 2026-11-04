import type { TraceFlagTargetStatus } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag, traceFlagLogTypeFlag } from '../../../flags.js';
import { otherLogTypeWarning } from '../../../traceFlagNotes.js';
import { traceTarget } from '../../../traceTarget.js';

export default class TraceFlagStatus extends AlvCommand<TraceFlagTargetStatus> {
  public static override readonly summary = 'Show trace flag status for a user or system target.';
  public static override readonly flags = {
    'automated-process': Flags.boolean({ default: false, summary: 'Target Automated Process.' }),
    'current-user': Flags.boolean({ default: false, summary: 'Target the current org user.' }),
    'log-type': traceFlagLogTypeFlag,
    'platform-integration': Flags.boolean({ default: false, summary: 'Target Platform Integration.' }),
    'target-org': targetOrgFlag,
    'user-id': Flags.string({ summary: 'Target a Salesforce user id.' })
  };

  public override async run(): Promise<TraceFlagTargetStatus> {
    const { flags } = await this.parse(TraceFlagStatus);
    const status = await core.traceFlag.status({
      logType: flags['log-type'],
      target: traceTarget(flags),
      targetOrg: flags['target-org']
    });
    const warning = otherLogTypeWarning(status);
    if (warning) this.warn(warning);
    return this.printResult(status);
  }
}
