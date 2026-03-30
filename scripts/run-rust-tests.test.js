const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createRustTestPlan } = require("./run-rust-tests");

test("createRustTestPlan falls back to cargo test workspace when nextest is unavailable", () => {
  const repoRoot = path.join("C:", "repo");

  const plan = createRustTestPlan({
    argv: [],
    env: {},
    repoRoot,
    nextestAvailable: false,
  });

  assert.equal(plan.mode, "workspace");
  assert.equal(plan.useNextest, false);
  assert.deepEqual(plan.steps, [
    {
      command: "cargo",
      args: ["test", "--workspace"],
      options: {
        cwd: repoRoot,
        env: {},
        stdio: "inherit",
      },
    },
  ]);
});

test("createRustTestPlan prefers cargo-nextest for workspace runs when available", () => {
  const repoRoot = path.join("C:", "repo");

  const plan = createRustTestPlan({
    argv: [],
    env: {},
    repoRoot,
    nextestAvailable: true,
  });

  assert.equal(plan.mode, "workspace");
  assert.equal(plan.useNextest, true);
  assert.deepEqual(plan.steps, [
    {
      command: "cargo",
      args: ["nextest", "run", "--workspace"],
      options: {
        cwd: repoRoot,
        env: {},
        stdio: "inherit",
      },
    },
  ]);
});

test("createRustTestPlan builds a CLI-first smoke plan without nextest", () => {
  const repoRoot = path.join("C:", "repo");

  const plan = createRustTestPlan({
    argv: ["--smoke", "--no-nextest"],
    env: {},
    repoRoot,
    nextestAvailable: true,
  });

  assert.equal(plan.mode, "smoke");
  assert.equal(plan.useNextest, false);
  assert.deepEqual(plan.steps, [
    {
      command: "cargo",
      args: ["test", "-p", "apex-log-viewer-cli", "--test", "cli_smoke", "--", "--nocapture"],
      options: {
        cwd: repoRoot,
        env: {},
        stdio: "inherit",
      },
    },
    {
      command: "cargo",
      args: ["test", "-p", "alv-core", "--test", "orgs_smoke", "--", "--nocapture"],
      options: {
        cwd: repoRoot,
        env: {},
        stdio: "inherit",
      },
    },
  ]);
});

test("createRustTestPlan builds a CLI-first smoke plan with nextest when available", () => {
  const repoRoot = path.join("C:", "repo");

  const plan = createRustTestPlan({
    argv: ["--smoke"],
    env: {},
    repoRoot,
    nextestAvailable: true,
  });

  assert.equal(plan.mode, "smoke");
  assert.equal(plan.useNextest, true);
  assert.deepEqual(plan.steps, [
    {
      command: "cargo",
      args: ["nextest", "run", "-p", "apex-log-viewer-cli", "--test", "cli_smoke"],
      options: {
        cwd: repoRoot,
        env: {},
        stdio: "inherit",
      },
    },
    {
      command: "cargo",
      args: ["nextest", "run", "-p", "alv-core", "--test", "orgs_smoke"],
      options: {
        cwd: repoRoot,
        env: {},
        stdio: "inherit",
      },
    },
  ]);
});

test("createRustTestPlan fails when nextest is explicitly requested but unavailable", () => {
  const repoRoot = path.join("C:", "repo");

  assert.throws(
    () =>
      createRustTestPlan({
        argv: ["--nextest"],
        env: {},
        repoRoot,
        nextestAvailable: false,
      }),
    /cargo-nextest was requested but is not installed/i
  );
});
