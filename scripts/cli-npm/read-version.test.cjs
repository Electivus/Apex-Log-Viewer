const assert = require('assert');

(async () => {
  const { readCargoVersion } = await import('./read-version.mjs');
  const version = readCargoVersion('scripts/cli-npm/fixtures/Cargo.toml');
  assert.strictEqual(version, '1.2.3');
  console.log('version ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
