import type { LogsTriageEntry } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag, workspaceRootFlag } from '../../../flags.js';

export default class LogTriage extends AlvCommand<LogsTriageEntry[]> {
  public static override readonly summary = 'Triage one or more Apex logs for failures.';
  public static override readonly flags = {
    'log-id': Flags.string({ multiple: true, required: true, summary: 'Apex log id; repeat for multiple logs.' }),
    'log-start-times': Flags.string({ summary: 'JSON object mapping log ids to ISO start times.' }),
    'target-org': targetOrgFlag,
    'workspace-root': workspaceRootFlag
  };

  public override async run(): Promise<LogsTriageEntry[]> {
    const { flags } = await this.parse(LogTriage);
    let logStartTimes: Record<string, string> | undefined;
    if (flags['log-start-times']) {
      const parsed: unknown = JSON.parse(flags['log-start-times']);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--log-start-times must be a JSON object.');
      }
      logStartTimes = parsed as Record<string, string>;
    }
    return this.printResult(
      await core.log.triage({
        logIds: flags['log-id'],
        logStartTimes,
        username: flags['target-org'],
        workspaceRoot: flags['workspace-root'] ?? process.cwd()
      })
    );
  }
}
