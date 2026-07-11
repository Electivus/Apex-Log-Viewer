import type { DoctorResult } from '@alv/core/contracts';
import { AlvCommand } from '../../command.js';
import { core } from '../../core.js';
import { targetOrgFlag } from '../../flags.js';

export default class Doctor extends AlvCommand<DoctorResult> {
  public static override readonly summary = 'Check the Apex Log Viewer runtime and local log store.';
  public static override readonly flags = { 'target-org': targetOrgFlag };

  public override async run(): Promise<DoctorResult> {
    const { flags } = await this.parse(Doctor);
    return this.printResult(await core.doctor({ targetOrg: flags['target-org'] }));
  }
}
