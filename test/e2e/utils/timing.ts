function envFlag(name: string): boolean {
  const value = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true';
}

export function isE2eTimingEnabled(): boolean {
  return envFlag('ALV_E2E_TIMING');
}

export async function timeE2eStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!isE2eTimingEnabled()) {
    return await run();
  }

  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    console.log(`[e2e][timing] ${label}: ${Date.now() - startedAt}ms`);
  }
}
