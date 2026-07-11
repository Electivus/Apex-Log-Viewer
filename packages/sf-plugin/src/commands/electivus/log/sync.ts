import type { LogsSyncResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag, workspaceRootFlag } from '../../../flags.js';

export default class LogSync extends AlvCommand<LogsSyncResult> {
  public static override readonly summary = 'Synchronize Apex logs into the canonical local store.';
  public static override readonly flags = {
    concurrency: Flags.integer({ min: 1, summary: 'Concurrent log downloads.' }),
    'force-full': Flags.boolean({ default: false, summary: 'Ignore the incremental checkpoint.' }),
    'target-org': targetOrgFlag,
    'workspace-root': workspaceRootFlag
  };

  public override async run(): Promise<LogsSyncResult> {
    const { flags } = await this.parse(LogSync);
    return this.printResult(
      await core.log.sync({
        concurrency: flags.concurrency,
        forceFull: flags['force-full'],
        targetOrg: flags['target-org'],
        workspaceRoot: flags['workspace-root'] ?? process.cwd()
      })
    );
  }
}
