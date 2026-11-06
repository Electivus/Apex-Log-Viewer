import path from 'node:path';
import { Config } from '@oclif/core';
import CustomLogCapture from '../packages/sf-plugin/src/commands/electivus/custom-log/capture.ts';
import { core } from '../packages/sf-plugin/src/core.ts';

async function main(): Promise<void> {
  const config = await Config.load({ root: process.env.DIAG_PLUGIN_ROOT! });
  await new CustomLogCapture(process.argv.slice(2), config)._run();
  await core.dispose();
}
void path;
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
