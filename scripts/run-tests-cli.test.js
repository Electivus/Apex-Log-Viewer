const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createRunnerPlan } = require("./run-tests-cli");

test("createRunnerPlan runs the VS Code host runner directly without coverage", () => {
  const repoRoot = path.join("C:", "repo");
  const execPath = path.join("C:", "Program Files", "nodejs", "node.exe");

  const plan = createRunnerPlan({
    argv: ["--scope=unit"],
    env: {},
    execPath,
    repoRoot,
  });

  assert.equal(plan.command, execPath);
  assert.deepEqual(plan.args, [
    path.join(repoRoot, "scripts", "run-tests.js"),
    "--scope=unit",
  ]);
  assert.equal(plan.env.NODE_OPTIONS, undefined);
});

test("createRunnerPlan wraps the VS Code host runner with c8 when coverage is enabled", () => {
  const repoRoot = path.join("C:", "repo");
  const execPath = path.join("C:", "Program Files", "nodejs", "node.exe");

  const plan = createRunnerPlan({
    argv: ["--scope=unit", "--coverage"],
    env: { NODE_OPTIONS: "--trace-warnings" },
    execPath,
    repoRoot,
    resolveModule(request) {
      assert.equal(request, "c8/bin/c8.js");
      return path.join(repoRoot, "node_modules", "c8", "bin", "c8.js");
    },
  });

  assert.equal(plan.command, execPath);
  assert.equal(plan.args[0], "--enable-source-maps");
  assert.match(plan.args[1], /c8[\\/]bin[\\/]c8\.js$/);
  assert.deepEqual(plan.args.slice(2, 12), [
    "--exclude",
    "src/webview/**",
    "--exclude-after-remap",
    "--report-dir",
    path.join(repoRoot, "coverage", "extension"),
    "--reporter",
    "json",
    "--reporter",
    "json-summary",
    "--reporter",
  ]);
  assert.deepEqual(plan.args.slice(12), [
    "lcovonly",
    "--reporter",
    "html",
    execPath,
    path.join(repoRoot, "scripts", "run-tests.js"),
    "--scope=unit",
  ]);
  assert.equal(plan.env.NODE_OPTIONS, "--trace-warnings");
});
