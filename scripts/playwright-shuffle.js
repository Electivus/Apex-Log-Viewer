'use strict';

/** A bare `--shuffle` takes a following spec path as its seed, so the seed always travels as `--shuffle=<seed>`. */
function resolvePlaywrightShuffleArgs(extraArgs = [], env = process.env) {
  if (extraArgs.some(arg => arg === '--shuffle' || String(arg).startsWith('--shuffle='))) {
    return [];
  }

  const configured = String(env.PLAYWRIGHT_SHUFFLE ?? '').trim();
  if (!configured) {
    return [];
  }

  if (configured !== 'random' && !/^\d+$/.test(configured)) {
    throw new Error(`PLAYWRIGHT_SHUFFLE must be 'random' or a numeric seed, got '${configured}'.`);
  }

  const seed = configured === 'random' ? String(Math.floor(Math.random() * 1e9)) : configured;
  return [`--shuffle=${seed}`];
}

module.exports = { resolvePlaywrightShuffleArgs };
