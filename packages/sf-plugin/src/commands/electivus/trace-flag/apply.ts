import type { TraceFlagApplyResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';
import { traceTarget } from '../../../traceTarget.js';

export default class TraceFlagApply extends AlvCommand<TraceFlagApplyResult> {
  public static override readonly summary = 'Create or update a trace flag with explicit safety controls.';
  public static override readonly flags = {
    'automated-process': Flags.boolean({ default: false, summary: 'Target Automated Process.' }),
    'current-user': Flags.boolean({ default: false, summary: 'Target the current org user.' }),
    'debug-level': Flags.string({ required: true, summary: 'Debug level developer name.' }),
    'dry-run': dryRunFlag,
    'platform-integration': Flags.boolean({ default: false, summary: 'Target Platform Integration.' }),
    'target-org': targetOrgFlag,
    'ttl-minutes': Flags.integer({ min: 1, summary: 'Trace flag lifetime in minutes.' }),
    'user-id': Flags.string({ summary: 'Target a Salesforce user id.' }),
    yes: yesFlag
  };

  public override async run(): Promise<TraceFlagApplyResult> {
    const { flags } = await this.parse(TraceFlagApply);
    return this.printResult(
      await core.traceFlag.apply({
        confirmed: flags.yes,
        debugLevelName: flags['debug-level'],
        dryRun: flags['dry-run'],
        target: traceTarget(flags),
        targetOrg: flags['target-org'],
        ttlMinutes: flags['ttl-minutes']
      })
    );
  }
}
