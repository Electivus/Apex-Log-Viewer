"use strict";

const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WEBVIEW_EXCLUDE = "src/webview/**";

function isCoverageEnabled(argv, env) {
  return argv.includes("--coverage") || /^(1|true)$/i.test(String(env.ENABLE_COVERAGE || ""));
}

function createRunnerPlan({
  argv,
  env,
  execPath,
  repoRoot,
  resolveModule = require.resolve,
}) {
  const nextEnv = { ...(env || {}) };
  const forwardArgs = (argv || []).filter((arg) => arg !== "--coverage");
  const runnerScript = path.join(repoRoot, "scripts", "run-tests.js");

  if (!isCoverageEnabled(argv || [], nextEnv)) {
    return {
      command: execPath,
      args: [runnerScript, ...forwardArgs],
      env: nextEnv,
    };
  }

  const reportDir = path.join(repoRoot, "coverage", "extension");

  return {
    command: execPath,
    args: [
      "--enable-source-maps",
      resolveModule("c8/bin/c8.js"),
      "--exclude",
      WEBVIEW_EXCLUDE,
      "--exclude-after-remap",
      "--report-dir",
      reportDir,
      "--reporter",
      "json",
      "--reporter",
      "json-summary",
      "--reporter",
      "lcovonly",
      "--reporter",
      "html",
      execPath,
      runnerScript,
      ...forwardArgs,
    ],
    env: nextEnv,
    reportDir,
  };
}

function run(plan) {
  if (plan.reportDir) {
    mkdirSync(plan.reportDir, { recursive: true });
  }

  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: plan.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (require.main === module) {
  run(
    createRunnerPlan({
      argv: process.argv.slice(2),
      env: process.env,
      execPath: process.execPath,
      repoRoot: path.resolve(__dirname, ".."),
    })
  );
}

module.exports = {
  createRunnerPlan,
  run,
};
