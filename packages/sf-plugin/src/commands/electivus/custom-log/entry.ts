import type { CustomLogEntryResult, PrintsAsJson } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { sourceFlag } from '../../../customLogFlags.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogEntry extends AlvCommand<PrintsAsJson<CustomLogEntryResult>> {
  public static override readonly summary =
    'Show one log entry with its full message, its long fields such as stack traces, record JSON and HTTP bodies, and its raw JSON payload.';
  public static override readonly flags = {
    'entry-id': Flags.string({ required: true, summary: 'Entry id from "custom-log get".' }),
    source: sourceFlag,
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<PrintsAsJson<CustomLogEntryResult>> {
    const { flags } = await this.parse(CustomLogEntry);
    return this.printResult(
      await core.customLog.entry({
        targetOrg: flags['target-org'],
        projectDir: process.cwd(),
        source: flags.source,
        entryId: flags['entry-id']
      })
    );
  }
}
