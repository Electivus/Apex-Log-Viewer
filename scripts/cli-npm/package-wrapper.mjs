import fs from 'fs';
import path from 'path';
import { readCargoVersion } from './read-version.mjs';

const [,, outDir, ...platforms] = process.argv;
if (!outDir || platforms.length === 0) {
  throw new Error('usage: package-wrapper <outDir> <platformName...>');
}

const version = readCargoVersion('crates/cli/Cargo.toml');
const templateDir = 'crates/cli/npm/wrapper';
const pkgDir = path.join(outDir, 'wrapper');

fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });

const pkgJson = JSON.parse(fs.readFileSync(path.join(templateDir, 'package.json'), 'utf8'));
const optionalDeps = Object.fromEntries(
  platforms.map((p) => [`@electivus/apex-log-viewer-cli-${p}`, version])
);

const patched = JSON.stringify({
  ...pkgJson,
  version,
  optionalDependencies: optionalDeps
}, null, 2);

fs.writeFileSync(path.join(pkgDir, 'package.json'), `${patched}\n`);
fs.copyFileSync(path.join(templateDir, 'README.md'), path.join(pkgDir, 'README.md'));
fs.copyFileSync('LICENSE', path.join(pkgDir, 'LICENSE'));
fs.copyFileSync(path.join(templateDir, 'bin', 'apex-log-viewer.js'), path.join(pkgDir, 'bin', 'apex-log-viewer.js'));
fs.copyFileSync(path.join(templateDir, 'lib', 'resolve-platform.cjs'), path.join(pkgDir, 'lib', 'resolve-platform.cjs'));
