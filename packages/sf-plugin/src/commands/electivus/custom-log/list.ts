import { CUSTOM_LOG_LIMITS, type CustomLogListResult, type PrintsAsJson } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { cursorFlag, minLevelFlag, payloadFieldsFlag, sourceFlag } from '../../../customLogFlags.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogList extends AlvCommand<PrintsAsJson<CustomLogListResult>> {
  public static override readonly summary =
    'List application log records (for example Nebula Logger logs), newest first.';
  public static override readonly flags = {
    cursor: cursorFlag,
    limit: Flags.integer({
      min: 1,
      max: CUSTOM_LOG_LIMITS.list.max,
      summary: `Maximum rows per page (default ${CUSTOM_LOG_LIMITS.list.default}).`
    }),
    'min-level': minLevelFlag,
    'payload-fields': payloadFieldsFlag,
    since: Flags.string({
      summary: 'Keep rows at or after this ISO-8601 instant, or within a duration such as 30m, 24h or 7d.'
    }),
    source: sourceFlag,
    'target-org': targetOrgFlag,
    until: Flags.string({ summary: 'Keep rows before this ISO-8601 instant, or before a duration ago such as 1h.' }),
    user: Flags.string({ summary: 'Username that logged the row.' })
  };

  public override async run(): Promise<PrintsAsJson<CustomLogListResult>> {
    const { flags } = await this.parse(CustomLogList);
    return this.printResult(
      await core.customLog.list({
        targetOrg: flags['target-org'],
        projectDir: process.cwd(),
        source: flags.source,
        limit: flags.limit,
        cursor: flags.cursor,
        filter: { minLevel: flags['min-level'], user: flags.user, since: flags.since, until: flags.until },
        payloadFields: flags['payload-fields']
      })
    );
  }
}
