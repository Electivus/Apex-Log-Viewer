import { CUSTOM_LOG_LIMITS, type CustomLogListResult, type PrintsAsJson } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { cursorFlag, minLevelFlag, payloadFieldsFlag, sourceFlag } from '../../../customLogFlags.js';
import { CUSTOM_LOG_REFERENCE_NOTE } from '../../../customLogReference.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogList extends AlvCommand<PrintsAsJson<CustomLogListResult>> {
  public static override readonly summary =
    'List application log records (for example Nebula Logger logs), newest first.';
  public static override readonly description =
    'A row of an events source is one stored event. ' +
    'With --entries, a source with a transaction header, such as Nebula Logger, lists one row per entry record instead, ' +
    'and each row carries the transaction it belongs to in its log field, with the header columns named in logColumns; ' +
    'pass log.id to "custom-log get --log-id" to read that transaction. --min-level then filters the entry level. ' +
    'Other sources list entries either way. Without --payload-fields, each row keeps up to 200 payload paths; ' +
    'take the columns from payload.transaction in "custom-log sources --json" on a source with a transaction header listed without --entries, and from payload.entry otherwise, to keep the output small. ' +
    'A column from the other level matches nothing and gives no error.\n\n' +
    CUSTOM_LOG_REFERENCE_NOTE;
  public static override readonly flags = {
    cursor: cursorFlag,
    entries: Flags.boolean({
      summary: 'List entry records, each with its transaction in log, instead of one row per transaction.'
    }),
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
        payloadFields: flags['payload-fields'],
        ...(flags.entries ? { entries: true } : {})
      })
    );
  }
}
