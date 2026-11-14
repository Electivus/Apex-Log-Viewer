/**
 * Property runs that CI can repeat. fast-check seeds from the clock by default; a pinned seed gives
 * every run the same inputs, and a failure still prints its seed and path for replay.
 * `ALV_FC_SEED` and `ALV_FC_RUNS` widen the search locally without editing a test.
 * Property tests take `fc` from here, so none of them runs on the clock seed.
 */

import fc from 'fast-check';

import { AlvError } from '../../src/errors.ts';

function integerFrom(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return raw?.trim() && Number.isSafeInteger(value) ? value : undefined;
}

fc.configureGlobal({
  seed: integerFrom(process.env.ALV_FC_SEED) ?? 1379,
  numRuns: Math.max(1, integerFrom(process.env.ALV_FC_RUNS) ?? 300)
});

export { fc };

/** The value `parse` returns, or the AlvError it throws with `code`. Any other throw fails the property. */
export function returnsOrFailsWith<T>(code: string, parse: () => T): T | AlvError {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AlvError && error.code === code) return error;
    throw error;
  }
}
