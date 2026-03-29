const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

test("run-node-tests targets the Node-only extension test tree", async () => {
  const scriptPath = path.join(__dirname, "run-node-tests.js");
  const runner = require(scriptPath);

  assert.equal(typeof runner.collectTests, "function");

  const files = runner.collectTests(
    path.join(__dirname, "..", "apps", "vscode-extension", "src", "node-test"),
  );

  assert.ok(
    files.some((file) => file.endsWith(path.join("src", "node-test", "runtime", "runtimeClient.telemetry.test.ts"))),
  );
  assert.ok(
    files.some((file) => file.endsWith(path.join("src", "node-test", "salesforce.exec.telemetry.test.ts"))),
  );
  assert.ok(files.every((file) => file.includes(`${path.sep}node-test${path.sep}`)));
});
