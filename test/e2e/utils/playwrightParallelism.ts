export type PlaywrightParallelism = {
  fullyParallel: boolean;
  workers: number;
};

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = String(env[name] || '').trim();
  return value || undefined;
}

function resolveConfiguredWorkers(env: NodeJS.ProcessEnv): number {
  const rawWorkers = readEnvValue(env, 'PLAYWRIGHT_WORKERS');
  if (!rawWorkers || !/^\d+$/.test(rawWorkers)) {
    return 1;
  }

  const workers = Number(rawWorkers);
  return Number.isFinite(workers) && workers > 0 ? workers : 1;
}

function resolvePoolMode(env: NodeJS.ProcessEnv): boolean {
  const strategy = String(env.SF_SCRATCH_STRATEGY || '')
    .trim()
    .toLowerCase();
  if (strategy === 'pool') {
    return true;
  }
  if (strategy === 'single') {
    return false;
  }
  if (strategy) {
    throw new Error(`Invalid SF_SCRATCH_STRATEGY value '${strategy}'. Expected 'single' or 'pool'.`);
  }
  return Boolean(readEnvValue(env, 'SF_SCRATCH_POOL_NAME'));
}

export function resolvePlaywrightParallelism(env: NodeJS.ProcessEnv = process.env): PlaywrightParallelism {
  const poolMode = resolvePoolMode(env);
  return {
    fullyParallel: poolMode,
    workers: poolMode ? resolveConfiguredWorkers(env) : 1
  };
}
