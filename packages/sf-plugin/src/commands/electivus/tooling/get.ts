import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class ToolingGet extends AlvCommand<unknown> {
  public static override readonly summary = 'Perform a read-only Tooling API GET request.';
  public static override readonly flags = {
    path: Flags.string({ required: true, summary: 'Relative Tooling API path.' }),
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<unknown> {
    const { flags } = await this.parse(ToolingGet);
    return this.printResult(await core.tooling.get({ path: flags.path, targetOrg: flags['target-org'] }));
  }
}
