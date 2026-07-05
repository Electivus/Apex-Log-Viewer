#!/usr/bin/env -S node --import tsx --no-warnings=ExperimentalWarning

async function main() {
  const { execute } = await import('@oclif/core');
  await execute({ development: true, dir: import.meta.url });
}

await main();
