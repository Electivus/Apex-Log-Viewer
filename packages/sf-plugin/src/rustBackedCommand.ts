import { SfCommand } from '@salesforce/sf-plugins-core';

import { executeRustBackedCommand, RuntimeExitError } from './runtime.js';

export abstract class RustBackedCommand<T> extends SfCommand<T> {
  public static override readonly strict = false;

  public override async run(): Promise<T> {
    try {
      return (await executeRustBackedCommand({
        argv: this.argv,
        jsonEnabled: this.jsonEnabled(),
        cwd: process.cwd(),
        env: process.env,
        stdout: process.stdout,
        stderr: process.stderr
      })) as T;
    } catch (error) {
      if (error instanceof RuntimeExitError) {
        this.exit(error.exitCode);
      }
      throw error;
    }
  }
}
