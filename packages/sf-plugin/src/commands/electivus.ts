import { SfCommand } from '@salesforce/sf-plugins-core';

import { executeElectivus, formatTextResult } from '../native.js';

export default class Electivus extends SfCommand<unknown> {
  public static override readonly strict = false;

  public static override readonly summary = 'Run Electivus Salesforce tools';

  public static override readonly description =
    'Runs Electivus Apex Log Viewer commands through the embedded TypeScript Salesforce runtime.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> doctor',
    '<%= config.bin %> <%= command.id %> logs sync --target-org my-org',
    '<%= config.bin %> <%= command.id %> logs status --target-org my-org --json',
    '<%= config.bin %> <%= command.id %> trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG',
    '<%= config.bin %> <%= command.id %> tooling query "SELECT Id FROM ApexLog" --target-org my-org'
  ];

  public override async run(): Promise<unknown> {
    const result = await executeElectivus(this.argv);
    if (!this.argv.includes('--json')) {
      this.log(formatTextResult(result));
    }
    return result;
  }
}
