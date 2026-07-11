import type { RuntimeLogRow } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class LogList extends AlvCommand<RuntimeLogRow[]> {
  public static override readonly summary = 'List Apex logs from a Salesforce org.';
  public static override readonly flags = {
    'before-id': Flags.string({ summary: 'Log id paired with --before-start-time for cursor pagination.' }),
    'before-start-time': Flags.string({ summary: 'ISO start time for cursor pagination.' }),
    limit: Flags.integer({ min: 1, summary: 'Maximum number of logs.' }),
    offset: Flags.integer({ min: 0, summary: 'Legacy offset pagination.' }),
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<RuntimeLogRow[]> {
    const { flags } = await this.parse(LogList);
    if (Boolean(flags['before-id']) !== Boolean(flags['before-start-time'])) {
      throw new Error('--before-id and --before-start-time must be supplied together.');
    }
    return this.printResult(
      await core.log.list({
        username: flags['target-org'],
        limit: flags.limit,
        offset: flags.offset,
        cursor:
          flags['before-id'] && flags['before-start-time']
            ? { beforeId: flags['before-id'], beforeStartTime: flags['before-start-time'] }
            : undefined
      })
    );
  }
}
