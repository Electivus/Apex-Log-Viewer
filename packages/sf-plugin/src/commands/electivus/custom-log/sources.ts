import type { CustomLogSourcesResult, PrintsAsJson } from '@alv/core/contracts';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { CUSTOM_LOG_REFERENCE_NOTE } from '../../../customLogReference.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogSources extends AlvCommand<PrintsAsJson<CustomLogSourcesResult>> {
  public static override readonly summary =
    'List the application log sources found in an org: built-in Nebula Logger detection and sfdx-project.json mappings.';
  public static override readonly description =
    "A source's payload.<level>.columns in --json lists the payload columns it maps. " +
    'Pass them to "custom-log list" as --payload-fields to keep rows small: list reads payload.transaction on a source with a transaction header and payload.entry on any other, and get reads payload.entry. ' +
    'A plain-string payload mapping lists no columns, and a source that is not ready has an empty payload.\n\n' +
    CUSTOM_LOG_REFERENCE_NOTE;
  public static override readonly flags = {
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<PrintsAsJson<CustomLogSourcesResult>> {
    const { flags } = await this.parse(CustomLogSources);
    return this.printResult(
      await core.customLog.sources({ targetOrg: flags['target-org'], projectDir: process.cwd() })
    );
  }
}
