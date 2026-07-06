import { executeElectivus, formatJsonResult, formatTextResult } from './native.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  try {
    const result = await executeElectivus(argv);
    if (json) {
      process.stdout.write(formatJsonResult(result));
    } else {
      process.stdout.write(formatTextResult(result));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ status: 'error', message })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
