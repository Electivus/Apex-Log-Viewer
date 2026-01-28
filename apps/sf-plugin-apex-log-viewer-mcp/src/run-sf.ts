export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunSfOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export async function runSfCommand(_args: string[], _options: RunSfOptions): Promise<RunResult> {
  throw new Error('Not implemented');
}

export function parseSfJson(_stdout: string): unknown {
  throw new Error('Not implemented');
}
