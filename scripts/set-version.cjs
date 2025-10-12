#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const version = process.argv[2] || process.env.VERSION;
if (!version) {
  console.error('Usage: node scripts/set-version.cjs <version>');
  process.exit(1);
}

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeJson(pkgPath, pkg);

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = version;
  }
  writeJson(lockPath, lock);
}

console.log(`Set package version to ${version}`);
