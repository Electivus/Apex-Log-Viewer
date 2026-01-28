import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSfJson, runSfCommand, type RunResult, type RunSfOptions } from './run-sf.js';

export type ApexLogsSyncParams = {
  targetOrg?: string;
  outputDir?: string;
  limit?: number;
};

export type NormalizedParams = {
  targetOrg?: string;
  outputDir: string;
  limit: number;
};

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export function normalizeParams(params: ApexLogsSyncParams, cwd: string): NormalizedParams {
  const rawLimit = Number.isFinite(params.limit) ? Math.trunc(params.limit as number) : DEFAULT_LIMIT;
  const clampedLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rawLimit));
  const outputDir = path.resolve(cwd, params.outputDir ?? 'apexlogs');
  const targetOrg = params.targetOrg?.trim() ? params.targetOrg.trim() : undefined;

  return {
    targetOrg,
    outputDir,
    limit: clampedLimit
  };
}

export function buildSfArgs(params: NormalizedParams): string[] {
  const args = ['apex-log-viewer', 'logs', 'sync', '--json'];

  if (params.targetOrg) {
    args.push('--target-org', params.targetOrg);
  }

  if (params.outputDir) {
    args.push('--output-dir', params.outputDir);
  }

  args.push('--limit', String(params.limit));

  return args;
}

export type RunSf = (args: string[], options: RunSfOptions) => Promise<RunResult>;

export async function runApexLogsSync(
  params: ApexLogsSyncParams,
  options: { cwd: string; env: NodeJS.ProcessEnv; runSf?: RunSf }
): Promise<unknown> {
  const normalized = normalizeParams(params, options.cwd);
  await fs.mkdir(normalized.outputDir, { recursive: true });

  const args = buildSfArgs(normalized);
  const runSf = options.runSf ?? runSfCommand;
  const result = await runSf(args, { cwd: options.cwd, env: options.env });

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || 'sf command failed';
    throw new Error(`sf command failed: ${message}`);
  }

  return parseSfJson(result.stdout);
}
