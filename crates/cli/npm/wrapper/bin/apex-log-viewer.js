#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const { resolvePlatform } = require('../lib/resolve-platform.cjs');

function main() {
  const { packageName, binName } = resolvePlatform(process.platform, process.arch);
  const pkgRoot = path.dirname(require.resolve(`${packageName}/package.json`));
  const binPath = path.join(pkgRoot, 'bin', binName);
  const result = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

main();
