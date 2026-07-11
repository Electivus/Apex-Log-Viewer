import type { TraceFlagTargetStatus } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';
import { traceTarget } from '../../../traceTarget.js';

export default class TraceFlagStatus extends AlvCommand<TraceFlagTargetStatus> {
  public static override readonly summary = 'Show trace flag status for a user or system target.';
  public static override readonly flags = {
    'automated-process': Flags.boolean({ default: false, summary: 'Target Automated Process.' }),
    'current-user': Flags.boolean({ default: false, summary: 'Target the current org user.' }),
    'platform-integration': Flags.boolean({ default: false, summary: 'Target Platform Integration.' }),
    'target-org': targetOrgFlag,
    'user-id': Flags.string({ summary: 'Target a Salesforce user id.' })
  };

  public override async run(): Promise<TraceFlagTargetStatus> {
    const { flags } = await this.parse(TraceFlagStatus);
    return this.printResult(
      await core.traceFlag.status({ target: traceTarget(flags), targetOrg: flags['target-org'] })
    );
  }
}
