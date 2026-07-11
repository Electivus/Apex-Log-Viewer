import type { RuntimeDebugLevelRecord } from '@alv/core/contracts';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { developerNameFlag, idFlag, targetOrgFlag } from '../../../flags.js';

export default class DebugLevelGet extends AlvCommand<RuntimeDebugLevelRecord | undefined> {
  public static override readonly summary = 'Get a debug level by id or developer name.';
  public static override readonly flags = {
    'developer-name': developerNameFlag,
    id: idFlag,
    'target-org': targetOrgFlag
  };

  public override async run(): Promise<RuntimeDebugLevelRecord | undefined> {
    const { flags } = await this.parse(DebugLevelGet);
    if (Boolean(flags.id) === Boolean(flags['developer-name'])) {
      throw new Error('Supply exactly one of --id or --developer-name.');
    }
    return this.printResult(
      await core.debugLevel.get({
        developerName: flags['developer-name'],
        id: flags.id,
        targetOrg: flags['target-org']
      })
    );
  }
}
