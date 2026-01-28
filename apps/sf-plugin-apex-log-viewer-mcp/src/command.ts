import path from 'node:path';

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
