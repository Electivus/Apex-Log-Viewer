import { spawn } from 'node:child_process';

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunSfOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export function resolveSfBin(env: NodeJS.ProcessEnv): string {
  const bin = env.SF_BIN?.trim();
  return bin && bin.length > 0 ? bin : 'sf';
}

export async function runSfCommand(args: string[], options: RunSfOptions): Promise<RunResult> {
  const bin = resolveSfBin(options.env);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export function parseSfJson(stdout: string): unknown {
  if (!stdout || stdout.trim().length === 0) {
    throw new Error('Invalid JSON output: empty stdout');
  }

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('Invalid JSON output: failed to parse');
  }
}
