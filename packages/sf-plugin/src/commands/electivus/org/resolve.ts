import type { OrgResolveResult } from '@alv/core/contracts';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class OrgResolve extends AlvCommand<OrgResolveResult> {
  public static override readonly summary = 'Resolve a Salesforce org alias or username.';
  public static override readonly flags = { 'target-org': targetOrgFlag };

  public override async run(): Promise<OrgResolveResult> {
    const { flags } = await this.parse(OrgResolve);
    return this.printResult(await core.org.resolve({ targetOrg: flags['target-org'] }));
  }
}
