const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ensureDevHub, pretestSetup, resolveMissingExtensionIds, resolveRequiredDevHubConfig } = require("./run-tests");

const originalEnv = { ...process.env };

test("xvfb re-exec preserves original CLI flags", () => {
  const script = fs.readFileSync(path.join(__dirname, "run-tests.js"), "utf8");

  assert.match(
    script,
    /spawn\('xvfb-run', \[[\s\S]*process\.execPath,\s*__filename,\s*\.\.\.process\.argv\.slice\(2\)/,
  );
});

test("VS Code host runner targets the Nx app output paths", () => {
  const script = fs.readFileSync(path.join(__dirname, "run-tests.js"), "utf8");

  assert.match(script, /extensionDevelopmentPath\s*=\s*resolve\(__dirname,\s*'\.\.',\s*'apps',\s*'vscode-extension'\)/);
  assert.match(
    script,
    /extensionTestsPath\s*=\s*resolve\(__dirname,\s*'\.\.',\s*'apps',\s*'vscode-extension',\s*'out',\s*'test',\s*'runner\.js'\)/,
  );
  assert.match(
    script,
    /mkdirSync\(dirname\(outfile\),\s*\{\s*recursive:\s*true\s*\}\)/,
  );
});

test("VSIX smoke packaging delegates to the monorepo vsce helper", () => {
  const script = fs.readFileSync(path.join(__dirname, "run-tests.js"), "utf8");

  assert.match(script, /scripts',\s*'run-vsce\.js'/);
  assert.match(script, /'--skip-prepublish'/);
});

test("VSIX smoke validation keeps existsSync available for the packaged VSIX check", () => {
  const script = fs.readFileSync(path.join(__dirname, "run-tests.js"), "utf8");

  assert.match(script, /\{[^}]*existsSync[^}]*\}\s*=\s*require\('fs'\)/);
  assert.match(script, /if \(!existsSync\(smokeVsixPath\)\) throw new Error\('\[smoke\] VSIX not found'\);/);
});

test("resolveMissingExtensionIds reports missing dependencies instead of relying on local user extensions", () => {
  const output = [
    "salesforce.salesforcedx-vscode@58.5.0",
    "ms-vscode.cpptools@1.24.5"
  ].join("\n");

  assert.deepEqual(
    resolveMissingExtensionIds(
      ["salesforce.salesforcedx-vscode", "salesforce.salesforcedx-vscode-apex-replay-debugger"],
      output
    ),
    ["salesforce.salesforcedx-vscode-apex-replay-debugger"]
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

test("ensureDevHub validates an explicit alias without mutating global CLI config", async () => {
  const calls = [];

  const resolvedAlias = await ensureDevHub("sf", { alias: "ConfiguredDevHub" }, {
    execFileAsync: async (file, args) => {
      calls.push([file, args]);
      return { stdout: '{"status":0,"result":{}}' };
    },
  });

  assert.equal(resolvedAlias, "ConfiguredDevHub");
  assert.deepEqual(calls, [
    ["sf", ["org", "display", "-o", "ConfiguredDevHub", "--json"]],
  ]);
});

test("ensureDevHub extracts the username from noisy sf auth output when no alias is provided", async () => {
  const calls = [];

  const resolvedAlias = await ensureDevHub("sf", { authUrl: "force://redacted" }, {
    execFileAsync: async (file, args) => {
      calls.push([file, args]);
      return {
        stdout: [
          "Warning: config updated",
          '{"status":0,"result":{"username":"devhub@example.com"}}',
          "Done"
        ].join("\n")
      };
    },
    mkdtempSync: () => "C:\\temp\\alv-auth",
    writeFileSync: () => {},
    rmSync: () => {},
    join: (...parts) => parts.join("\\"),
    tmpdir: () => "C:\\temp",
  });

  assert.equal(resolvedAlias, "devhub@example.com");
  assert.deepEqual(calls, [
    [
      "sf",
      [
        "org",
        "login",
        "sfdx-url",
        "--sfdx-url-file",
        "C:\\temp\\alv-auth\\devhub.sfdxurl",
        "--set-default-dev-hub",
        "--json"
      ]
    ],
  ]);
});
