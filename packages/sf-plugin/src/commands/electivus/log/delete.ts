import type { LogsDeleteResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { dryRunFlag, targetOrgFlag, yesFlag } from '../../../flags.js';
import { resolveLogIds } from '../../../logDeleteIds.js';

export default class LogDelete extends AlvCommand<LogsDeleteResult> {
  public static override readonly summary = 'Delete Apex logs with an explicit preview or confirmation.';
  public static override readonly description =
    "Deletes the ApexLog records in the org. Local copies under apexlogs/ stay available for offline search, as with the extension's Clear logs action.";
  public static override readonly flags = {
    'dry-run': dryRunFlag,
    'ids-file': Flags.file({ exists: true, summary: 'File containing Apex log ids.' }),
    limit: Flags.integer({ min: 1, summary: 'Maximum logs selected by scope.' }),
    'log-id': Flags.string({ multiple: true, summary: 'Apex log id; repeat for multiple logs.' }),
    scope: Flags.option({ options: ['mine', 'all'] as const, default: 'mine', summary: 'Deletion scope.' })(),
    'target-org': targetOrgFlag,
    // Accepted so existing scripts keep working; deletion never touches local files.
    'workspace-root': Flags.directory({
      deprecated: {
        message: '--workspace-root has no effect: log delete removes org records only and keeps local copies.'
      },
      hidden: true,
      summary: 'Ignored. Local copies are kept.'
    }),
    yes: yesFlag
  };

  public override async run(): Promise<LogsDeleteResult> {
    const { flags } = await this.parse(LogDelete);
    const ids = await resolveLogIds(flags['log-id'], flags['ids-file']);
    return this.printResult(
      await core.log.delete({
        confirmed: flags.yes,
        dryRun: flags['dry-run'],
        ids,
        limit: flags.limit,
        scope: flags.scope,
        targetOrg: flags['target-org']
      })
    );
  }
}
