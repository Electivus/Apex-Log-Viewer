const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pretestSetup, resolveRequiredDevHubConfig } = require("./run-tests");

const originalEnv = { ...process.env };

test("xvfb re-exec preserves original CLI flags", () => {
  const script = fs.readFileSync(path.join(__dirname, "run-tests.js"), "utf8");

  assert.match(
    script,
    /spawn\('xvfb-run', \[[\s\S]*process\.execPath,\s*__filename,\s*\.\.\.process\.argv\.slice\(2\)/,
  );
});

test("resolveRequiredDevHubConfig ignores the legacy SFDX_AUTH_URL fallback", () => {
  process.env = {
    ...originalEnv,
    SFDX_AUTH_URL: "legacy-auth-url"
  };
  delete process.env.SF_DEVHUB_AUTH_URL;
  delete process.env.SF_DEVHUB_ALIAS;

  assert.throws(
    () => resolveRequiredDevHubConfig({ requireConfig: true }),
    /Missing required Dev Hub configuration\. Set SF_DEVHUB_AUTH_URL or SF_DEVHUB_ALIAS\./,
  );

  process.env = { ...originalEnv };
});

test("pretestSetup fails fast when scratch setup is enabled without explicit Dev Hub config", async () => {
  process.env = {
    ...originalEnv,
    SF_SETUP_SCRATCH: "1"
  };

  delete process.env.SF_DEVHUB_AUTH_URL;
  delete process.env.SF_DEVHUB_ALIAS;

  await assert.rejects(
    () =>
      pretestSetup("integration", {}, {
        ensureSfCliInstalled: async () => "sf",
      }),
    /Missing required Dev Hub configuration\. Set SF_DEVHUB_AUTH_URL or SF_DEVHUB_ALIAS\./,
  );

  process.env = { ...originalEnv };
});

test("pretestSetup propagates Dev Hub auth failures instead of continuing", async () => {
  let ensureDefaultScratchCalled = false;

  process.env = {
    ...originalEnv,
    SF_SETUP_SCRATCH: "1",
    SF_DEVHUB_ALIAS: "ConfiguredDevHub"
  };

  await assert.rejects(
    () =>
      pretestSetup("integration", {}, {
        ensureSfCliInstalled: async () => "sf",
        ensureDevHub: async () => {
          throw new Error("dev hub auth failed");
        },
        ensureDefaultScratch: async () => {
          ensureDefaultScratchCalled = true;
          return { cleanup: async () => {} };
        },
      }),
    /dev hub auth failed/,
  );

  assert.equal(ensureDefaultScratchCalled, false);
  process.env = { ...originalEnv };
});
