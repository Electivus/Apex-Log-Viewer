const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("vscode-extension project.json exposes the Task 3 Nx targets", () => {
  const projectJsonPath = path.join(__dirname, "..", "apps", "vscode-extension", "project.json");
  const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
  const targetNames = Object.keys(projectJson.targets || {}).sort();

  assert.deepEqual(targetNames, [
    "build",
    "check-types",
    "compile",
    "lint",
    "package",
    "test",
    "test-all",
    "test-ci",
    "test-e2e",
    "test-integration",
    "test-integration-ci",
    "test-smoke-vsix",
    "test-unit",
    "test-unit-ci",
    "vsce-package",
    "vsce-package-pre",
    "vsce-publish",
    "vsce-publish-pre",
    "watch",
  ]);
});
