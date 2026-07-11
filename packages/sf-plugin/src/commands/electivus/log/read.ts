import type { LogsReadResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag, workspaceRootFlag } from '../../../flags.js';

export default class LogRead extends AlvCommand<LogsReadResult> {
  public static override readonly summary = 'Read an Apex log from the local store or Salesforce.';
  public static override readonly flags = {
    'log-id': Flags.string({ required: true, summary: 'Apex log id.' }),
    'max-bytes': Flags.integer({ min: 1, summary: 'Maximum bytes returned.' }),
    'target-org': targetOrgFlag,
    'workspace-root': workspaceRootFlag
  };

  public override async run(): Promise<LogsReadResult> {
    const { flags } = await this.parse(LogRead);
    return this.printResult(
      await core.log.read({
        logId: flags['log-id'],
        maxBytes: flags['max-bytes'],
        targetOrg: flags['target-org'],
        workspaceRoot: flags['workspace-root'] ?? process.cwd()
      })
    );
  }
}
