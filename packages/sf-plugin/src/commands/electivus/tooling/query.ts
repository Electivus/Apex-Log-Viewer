import type { ToolingQueryResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class ToolingQuery extends AlvCommand<ToolingQueryResult> {
  public static override readonly summary = 'Run a read-only Tooling API SOQL query.';
  public static override readonly flags = {
    soql: Flags.string({ required: true, summary: 'Tooling API SOQL query.' }),
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<ToolingQueryResult> {
    const { flags } = await this.parse(ToolingQuery);
    return this.printResult(await core.tooling.query({ soql: flags.soql, targetOrg: flags['target-org'] }));
  }
}
