import fs from 'fs';
import path from 'path';
import { readCargoVersion } from './read-version.mjs';

const [,, targetTriple, platformName, os, cpu, binName, binaryPath, outDir] = process.argv;
if (!targetTriple || !platformName || !os || !cpu || !binName || !binaryPath || !outDir) {
  throw new Error('usage: package-platform <target> <platform> <os> <cpu> <bin> <binaryPath> <outDir>');
}

const version = readCargoVersion('crates/cli/Cargo.toml');
const templateDir = 'crates/cli/npm/platform';
const pkgDir = path.join(outDir, platformName);

fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });

const pkgJson = JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'));
const patched = JSON.stringify({
  ...pkgJson,
  name: `@electivus/apex-log-viewer-cli-${platformName}`,
  version,
  os: [os],
  cpu: [cpu],
  bin: { 'apex-log-viewer': `bin/${binName}` }
}, null, 2);

fs.writeFileSync(path.join(pkgDir, 'package.json'), `${patched}\n`);
fs.copyFileSync(path.join(templateDir, 'README.md'), path.join(pkgDir, 'README.md'));
fs.copyFileSync('LICENSE', path.join(pkgDir, 'LICENSE'));
fs.copyFileSync(binaryPath, path.join(pkgDir, 'bin', binName));
