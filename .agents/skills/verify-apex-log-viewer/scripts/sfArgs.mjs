// Pure helpers for verify.mjs, kept apart so scripts/verify-skill-args.test.mjs can test them without a session.

/** True when the arguments already name an org: `--target-org X`, `--target-org=X`, `-o X`, `-oX` or `-o=X`. */
export function hasTargetOrg(args) {
  return args.some(arg => arg === '--target-org' || arg.startsWith('--target-org=') || /^-o(?!-)/.test(arg));
}

/**
 * The evidence file name of an `sf` call: `sf-` plus its first two command words, the words before the first
 * flag. A flag's value, such as a path, never reaches the name, and any other character becomes `_`.
 */
export function evidenceName(args) {
  const firstFlag = args.findIndex(arg => arg.startsWith('-'));
  const words = (firstFlag === -1 ? args : args.slice(0, firstFlag)).slice(0, 2);
  const name = words.join('-').replace(/[^A-Za-z0-9._-]/g, '_');
  return `sf-${name || 'command'}`;
}

/** The scratch strategy as test/e2e/utils/scratchOrg.ts resolves it, or an `error` for a value it rejects. */
export function scratchStrategy(env) {
  const configured = String(env.SF_SCRATCH_STRATEGY || '')
    .trim()
    .toLowerCase();
  const poolName = String(env.SF_SCRATCH_POOL_NAME || '').trim();
  if (!configured) return { strategy: poolName ? 'pool' : 'single', poolName };
  if (configured === 'single' || configured === 'pool') return { strategy: configured, poolName };
  return {
    strategy: configured,
    poolName,
    error: `Invalid SF_SCRATCH_STRATEGY value '${configured}'. Expected 'single' or 'pool'.`
  };
}
