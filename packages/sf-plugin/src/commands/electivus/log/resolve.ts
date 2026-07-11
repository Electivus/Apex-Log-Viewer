import type { LogsResolveResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag, workspaceRootFlag } from '../../../flags.js';

export default class LogResolve extends AlvCommand<LogsResolveResult> {
  public static override readonly summary = 'Resolve an Apex log id to its canonical local path.';
  public static override readonly flags = {
    'log-id': Flags.string({ required: true, summary: 'Apex log id.' }),
    'target-org': targetOrgFlag,
    'workspace-root': workspaceRootFlag
  };

  public override async run(): Promise<LogsResolveResult> {
    const { flags } = await this.parse(LogResolve);
    return this.printResult(
      await core.log.resolve({
        logId: flags['log-id'],
        targetOrg: flags['target-org'],
        workspaceRoot: flags['workspace-root'] ?? process.cwd()
      })
    );
  }
}
