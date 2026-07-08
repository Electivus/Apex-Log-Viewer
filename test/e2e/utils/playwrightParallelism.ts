export type PlaywrightParallelism = {
  fullyParallel: boolean;
  workers: number;
};

export type PlaywrightTimeouts = {
  testTimeoutMs: number;
  expectTimeoutMs: number;
};

const DEFAULT_TEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_EXPECT_TIMEOUT_MS = 60 * 1000;

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = String(env[name] || '').trim();
  return value || undefined;
}

function resolvePositiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const rawValue = readEnvValue(env, name);
  if (!rawValue || !/^\d+$/.test(rawValue)) {
    return defaultValue;
  }

  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultValue;
}

function resolveConfiguredWorkers(env: NodeJS.ProcessEnv): number {
  return resolvePositiveIntegerEnv(env, 'PLAYWRIGHT_WORKERS', 1);
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

export function resolvePlaywrightTimeouts(env: NodeJS.ProcessEnv = process.env): PlaywrightTimeouts {
  return {
    testTimeoutMs: resolvePositiveIntegerEnv(env, 'PLAYWRIGHT_TIMEOUT_MS', DEFAULT_TEST_TIMEOUT_MS),
    expectTimeoutMs: resolvePositiveIntegerEnv(env, 'PLAYWRIGHT_EXPECT_TIMEOUT_MS', DEFAULT_EXPECT_TIMEOUT_MS)
  };
}
