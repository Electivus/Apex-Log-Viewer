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

export function normalizeParams(_params: ApexLogsSyncParams, _cwd: string): NormalizedParams {
  throw new Error('Not implemented');
}

export function buildSfArgs(_params: NormalizedParams): string[] {
  throw new Error('Not implemented');
}
