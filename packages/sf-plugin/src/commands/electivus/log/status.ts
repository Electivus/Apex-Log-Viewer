import type { LogsStatusResult } from '@alv/core/contracts';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag, workspaceRootFlag } from '../../../flags.js';

export default class LogStatus extends AlvCommand<LogsStatusResult> {
  public static override readonly summary = 'Show local Apex log synchronization status.';
  public static override readonly flags = { 'target-org': targetOrgFlag, 'workspace-root': workspaceRootFlag };

  public override async run(): Promise<LogsStatusResult> {
    const { flags } = await this.parse(LogStatus);
    return this.printResult(
      await core.log.status({ targetOrg: flags['target-org'], workspaceRoot: flags['workspace-root'] ?? process.cwd() })
    );
  }
}
