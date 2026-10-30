import type { CustomLogSourcesResult, PrintsAsJson } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class CustomLogSources extends AlvCommand<PrintsAsJson<CustomLogSourcesResult>> {
  public static override readonly summary =
    'List the application log sources found in an org: built-in Nebula Logger detection and sfdx-project.json mappings.';
  public static override readonly flags = {
    refresh: Flags.boolean({
      default: false,
      summary: 'Ignore cached detection and describe answers, misses included.'
    }),
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<PrintsAsJson<CustomLogSourcesResult>> {
    const { flags } = await this.parse(CustomLogSources);
    return this.printResult(
      await core.customLog.sources({
        targetOrg: flags['target-org'],
        projectDir: process.cwd(),
        refresh: flags.refresh
      })
    );
  }
}
