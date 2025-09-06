#!/usr/bin/env node
/*
 Inject Application Insights connection string into package.json (aiKey) from env.
 No secrets are committed; this runs only in CI before packaging, and can be reverted by strip script.
*/
const fs = require('fs');
const path = require('path');

try {
  const root = process.cwd();
  const pkgPath = path.join(root, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || process.env.VSCODE_TELEMETRY_CONNECTION_STRING;

  if (!conn) {
    console.log('[telemetry] No connection string in env; skipping injection.');
    process.exit(0);
  }

  // Write connection string to a non-legacy field; extension code reads it at runtime.
  pkg.telemetryConnectionString = conn;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[telemetry] Injected connection string into package.json telemetryConnectionString.');
} catch (e) {
  console.error('[telemetry] Failed to inject connection string:', e && e.message ? e.message : e);
  process.exit(1);
}
