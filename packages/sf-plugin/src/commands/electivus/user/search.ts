import type { UserSearchResult } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class UserSearch extends AlvCommand<UserSearchResult> {
  public static override readonly summary = 'Search Salesforce users for trace flag targeting.';
  public static override readonly flags = {
    limit: Flags.integer({ min: 1, summary: 'Maximum users returned.' }),
    query: Flags.string({ required: true, summary: 'Name, username, or email fragment.' }),
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<UserSearchResult> {
    const { flags } = await this.parse(UserSearch);
    return this.printResult(
      await core.user.search({ limit: flags.limit, query: flags.query, targetOrg: flags['target-org'] })
    );
  }
}
