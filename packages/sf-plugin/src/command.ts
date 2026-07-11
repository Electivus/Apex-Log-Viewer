import { SfCommand } from '@salesforce/sf-plugins-core';

type LogReadLike = { body: string; logId: string };

function isLogReadResult(value: unknown): value is LogReadLike {
  return Boolean(value) && typeof value === 'object' && typeof (value as LogReadLike).body === 'string';
}

export abstract class AlvCommand<TResult> extends SfCommand<TResult> {
  protected printResult(result: TResult): TResult {
    if (!this.jsonEnabled()) {
      if (isLogReadResult(result)) {
        process.stdout.write(result.body);
      } else if (typeof result === 'string') {
        this.log(result);
      } else {
        this.log(JSON.stringify(result, null, 2));
      }
    }
    return result;
  }
}
