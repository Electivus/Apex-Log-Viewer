// Pure helpers for verify.mjs, kept apart so scripts/verify-skill-args.test.mjs can test them without a session.

/** True when the arguments already name an org: `--target-org X`, `--target-org=X`, `-o X`, `-oX` or `-o=X`. */
export function hasTargetOrg(args) {
  return args.some(arg => arg === '--target-org' || arg.startsWith('--target-org=') || /^-o(?!-)/.test(arg));
}

/**
 * The arguments of `verify.mjs sf`: an optional `--linked`, which runs the real `sf` with the local plugin
 * linked, then an optional `--`, then the `sf electivus` arguments.
 */
export function splitSfArgs(rest) {
  const linked = rest[0] === '--linked';
  const args = linked ? rest.slice(1) : rest;
  return { linked, args: args[0] === '--' ? args.slice(1) : args };
}

/**
 * The Salesforce CLI that `sf --linked` runs, picked as test/e2e/utils/sfCli.ts picks it: `SF_CLI_BIN_PATH`, then
 * `ALV_SF_BIN_PATH` (the isolated CLI that scripts/run-macos-e2e.sh selects), then `sf` on PATH.
 */
export function sfBinary(env) {
  return String(env.SF_CLI_BIN_PATH || env.ALV_SF_BIN_PATH || '').trim() || 'sf';
}

/**
 * The evidence file name of an `sf` call: the prefix (`sf`, or `sf-linked` for the real `sf`) plus its first
 * two command words, the words before the first flag. A flag's value, such as a path, never reaches the name,
 * and any other character becomes `_`.
 */
export function evidenceName(args, prefix = 'sf') {
  const firstFlag = args.findIndex(arg => arg.startsWith('-'));
  const words = (firstFlag === -1 ? args : args.slice(0, firstFlag)).slice(0, 2);
  const name = words.join('-').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${prefix}-${name || 'command'}`;
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
