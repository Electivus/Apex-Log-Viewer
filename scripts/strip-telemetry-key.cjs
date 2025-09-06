#!/usr/bin/env node
/*
 Remove aiKey from package.json after packaging to avoid accidental commits.
*/
const fs = require('fs');
const path = require('path');

try {
  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  if (Object.prototype.hasOwnProperty.call(pkg, 'telemetryConnectionString')) {
    delete pkg.telemetryConnectionString;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[telemetry] Removed telemetryConnectionString from package.json.');
  } else {
    console.log('[telemetry] No telemetryConnectionString present; nothing to strip.');
  }
} catch (e) {
  console.error('[telemetry] Failed to strip aiKey:', e && e.message ? e.message : e);
  process.exit(1);
}
