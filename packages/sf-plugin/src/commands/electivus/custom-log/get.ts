import { CUSTOM_LOG_LIMITS, type CustomLogGetResult, type PrintsAsJson } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { cursorFlag, minLevelFlag, payloadFieldsFlag, sourceFlag } from '../../../customLogFlags.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogGet extends AlvCommand<PrintsAsJson<CustomLogGetResult>> {
  public static override readonly summary =
    'Show one logged transaction with its entries and the id of its Apex debug log, when one exists.';
  public static override readonly flags = {
    cursor: cursorFlag,
    limit: Flags.integer({
      min: 1,
      max: CUSTOM_LOG_LIMITS.entries.max,
      summary: `Maximum entries per page (default ${CUSTOM_LOG_LIMITS.entries.default}).`
    }),
    'log-id': Flags.string({ exactlyOne: ['log-id', 'transaction-id'], summary: 'Record id from "custom-log list".' }),
    'min-level': minLevelFlag,
    'payload-fields': payloadFieldsFlag,
    source: sourceFlag,
    'target-org': targetOrgFlag,
    'transaction-id': Flags.string({
      exactlyOne: ['log-id', 'transaction-id'],
      summary: 'Transaction id as the logging framework stored it, for example a Nebula TransactionId__c.'
    })
  };

  public override async run(): Promise<PrintsAsJson<CustomLogGetResult>> {
    const { flags } = await this.parse(CustomLogGet);
    const common = {
      targetOrg: flags['target-org'],
      projectDir: process.cwd(),
      source: flags.source,
      limit: flags.limit,
      cursor: flags.cursor,
      minLevel: flags['min-level'],
      payloadFields: flags['payload-fields']
    };
    return this.printResult(
      await core.customLog.get(
        flags['transaction-id'] === undefined
          ? { ...common, logId: flags['log-id'] as string }
          : { ...common, transactionId: flags['transaction-id'] }
      )
    );
  }
}
