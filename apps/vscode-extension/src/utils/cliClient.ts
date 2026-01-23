import * as cp from 'child_process';
import type { ApexLogRow } from '../shared/types';
import { getConfig } from './config';
import { localize } from './localize';
import { logTrace } from './logger';

const DEFAULT_CLI = 'apex-log-viewer';
const CLI_TIMEOUT_MS = 120000;

export type CliSyncOutput = {
  ok: true;
  apiVersion: string;
  limit: number;
  savedDir: string;
  org: { username?: string; instanceUrl: string };
  logs: ApexLogRow[];
  saved?: Array<{ id: string; file: string; size: number }>;
  skipped?: Array<{ id: string; reason: string }>;
  errors?: Array<{ id?: string; message: string }>;
};

export type CliErrorOutput = {
  ok: false;
  errorCode: string;
  message: string;
  details?: string;
};

export function parseSyncOutput(raw: string): CliSyncOutput {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(localize('cliInvalidJson', 'CLI output was not valid JSON.'));
  }
  if (data && data.ok === true) {
    return data as CliSyncOutput;
  }
  if (data && data.ok === false) {
    const code = data.errorCode || 'CLI_ERROR';
    const msg = data.message || 'CLI error';
    throw new Error(`${code}: ${msg}`);
  }
  throw new Error(localize('cliInvalidOutput', 'CLI output was not recognized.'));
}

function resolveCliPath(): string {
  const envPath = (process.env.APEX_LOG_VIEWER_CLI || '').trim();
  if (envPath) return envPath;
  const cfgPath = (getConfig<string>('electivus.apexLogs.cliPath', '') || '').trim();
  return cfgPath || DEFAULT_CLI;
}

function execCli(
  program: string,
  args: string[],
  cwd: string | undefined,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      program,
      args,
      { cwd, env: process.env, maxBuffer: 1024 * 1024 * 10, encoding: 'utf8', timeout: CLI_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const err: any = error;
          if (err.code === 'ENOENT') {
            reject(new Error(localize('cliNotFound', 'CLI not found: {0}', program)));
            return;
          }
          const msg = stderr || err.message || 'CLI error';
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      }
    );

    if (signal) {
      const onAbort = () => {
        try {
          child.kill();
        } catch {}
        reject(new Error('aborted'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      });
    }
  });
}

export async function syncLogs(options: {
  limit: number;
  target?: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<CliSyncOutput> {
  const program = resolveCliPath();
  const args = ['logs', 'sync', '--limit', String(options.limit)];
  if (options.target) {
    args.push('--target', options.target);
  }
  try {
    logTrace('cli.sync:', program, args.join(' '));
  } catch {}
  const stdout = await execCli(program, args, options.cwd, options.signal);
  return parseSyncOutput(stdout);
}
