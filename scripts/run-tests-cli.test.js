const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
  assert.deepEqual(plan.args.slice(2), [
    "--report-dir",
    path.join(repoRoot, "coverage", "extension"),
    "--reporter",
    "json",
    "--reporter",
    "json-summary",
    "--reporter",
    "lcovonly",
    "--reporter",
    "html",
    execPath,
    path.join(repoRoot, "scripts", "run-tests.js"),
    "--scope=unit",
  ]);
  assert.equal(plan.env.NODE_OPTIONS, "--trace-warnings");
});

test("createRunnerPlan ignores ENABLE_COVERAGE=false", () => {
  const repoRoot = path.join("C:", "repo");
  const execPath = path.join("C:", "Program Files", "nodejs", "node.exe");

  const plan = createRunnerPlan({
    argv: ["--scope=unit"],
    env: { ENABLE_COVERAGE: "false" },
    execPath,
    repoRoot,
  });

  assert.equal(plan.command, execPath);
  assert.deepEqual(plan.args, [
    path.join(repoRoot, "scripts", "run-tests.js"),
    "--scope=unit",
  ]);
  assert.equal(plan.reportDir, undefined);
});

test(".c8rc.json measures source files that exist and leaves tests out", () => {
  const repoRoot = path.join(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".c8rc.json"), "utf8"));
  const sourceFiles = (pattern) => fs.globSync(pattern, { cwd: repoRoot }).filter((file) => /\.tsx?$/.test(file));

  for (const pattern of config.include) {
    assert.ok(sourceFiles(pattern).length > 0, `.c8rc.json include "${pattern}" matches no source file`);
  }
  for (const testDir of ["apps/vscode-extension/src/test/**", "apps/vscode-extension/src/node-test/**"]) {
    assert.ok(sourceFiles(testDir).length > 0, `${testDir} holds no test file`);
    assert.ok(config.exclude.includes(testDir), `.c8rc.json must exclude ${testDir}`);
  }
});
