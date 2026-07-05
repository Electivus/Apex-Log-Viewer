import { RustBackedCommand } from '../rustBackedCommand.js';

export default class Electivus extends RustBackedCommand<unknown> {
  public static override readonly summary = 'Run Electivus Salesforce tools';

  public static override readonly description =
    'Runs Electivus Apex Log Viewer commands through the platform-native Rust runtime.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> doctor',
    '<%= config.bin %> <%= command.id %> logs sync --target-org my-org',
    '<%= config.bin %> <%= command.id %> logs status --target-org my-org --json',
    '<%= config.bin %> <%= command.id %> logs search "NullPointerException" --target-org my-org',
    '<%= config.bin %> <%= command.id %> trace-flags apply --target-org my-org --current-user --debug-level ALV_DEBUG',
    '<%= config.bin %> <%= command.id %> tooling query "SELECT Id FROM ApexLog" --target-org my-org'
  ];
}
