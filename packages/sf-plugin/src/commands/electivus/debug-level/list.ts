import type { RuntimeDebugLevelRecord } from '@alv/core/contracts';
import { AlvCommand } from '../../../command.js';
import { core } from '../../../core.js';
import { targetOrgFlag } from '../../../flags.js';

export default class DebugLevelList extends AlvCommand<RuntimeDebugLevelRecord[]> {
  public static override readonly summary = 'List debug levels.';
  public static override readonly flags = { 'target-org': targetOrgFlag };

  public override async run(): Promise<RuntimeDebugLevelRecord[]> {
    const { flags } = await this.parse(DebugLevelList);
    return this.printResult(await core.debugLevel.list({ targetOrg: flags['target-org'] }));
  }
}
