import type { OrgListItem } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';

export default class OrgList extends AlvCommand<OrgListItem[]> {
  public static override readonly summary = 'List authenticated Salesforce orgs.';
  public static override readonly flags = {
    'force-refresh': Flags.boolean({ default: false, summary: 'Refresh Salesforce auth state before listing orgs.' })
  };

  public override async run(): Promise<OrgListItem[]> {
    const { flags } = await this.parse(OrgList);
    return this.printResult(await core.org.list({ forceRefresh: flags['force-refresh'] }));
  }
}
