import { format } from 'node:util';

/**
 * Everything a command prints on stdout and stderr while `run` is pending. `sf` prints with
 * `console.log` and `console.error`; the test runner reports through the stream itself, so only the
 * console is replaced.
 */
export async function withStreams<T>(run: (streams: { out: string[]; err: string[] }) => Promise<T>) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(`${format(...args)}\n`);
  console.error = (...args: unknown[]) => void err.push(`${format(...args)}\n`);
  try {
    const value = await run({ out, err });
    return { value, out: out.join(''), err: err.join('') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

export async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
