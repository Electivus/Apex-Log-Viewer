"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function isFalseyFlag(value) {
  return /^(0|false|no)$/i.test(String(value || ""));
}

function isTruthyFlag(value) {
  return /^(1|true|yes)$/i.test(String(value || ""));
}

function prefersNextest(argv, env) {
  if ((argv || []).includes("--no-nextest")) {
    return false;
  }
  if (isFalseyFlag(env?.ALV_USE_NEXTEST)) {
    return false;
  }
  if ((argv || []).includes("--nextest")) {
    return true;
  }
  return true;
}

function detectNextest({ spawnSyncImpl = spawnSync, env, repoRoot } = {}) {
  try {
    const result = spawnSyncImpl("cargo", ["nextest", "--version"], {
      cwd: repoRoot,
      env,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function createRustTestPlan({
  argv,
  env,
  repoRoot,
  nextestAvailable,
}) {
  const args = argv || [];
  const mode = args.includes("--smoke") ? "smoke" : "workspace";
  const forceNextest = args.includes("--nextest") || isTruthyFlag(env?.ALV_USE_NEXTEST);
  const allowNextest = prefersNextest(args, env);

  if (forceNextest && !nextestAvailable) {
    throw new Error(
      "cargo-nextest was requested but is not installed. Install it with `cargo install cargo-nextest --locked` or rerun with --no-nextest."
    );
  }

  const useNextest = allowNextest && nextestAvailable;
  const baseOptions = {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  };

  if (mode === "smoke") {
    if (useNextest) {
      return {
        mode,
        useNextest,
        steps: [
          {
            command: "cargo",
            args: ["nextest", "run", "-p", "electivus-apex-log-viewer-cli", "--test", "cli_smoke"],
            options: baseOptions,
          },
          {
            command: "cargo",
            args: ["nextest", "run", "-p", "alv-core", "--test", "orgs_smoke"],
            options: baseOptions,
          },
        ],
      };
    }

    return {
      mode,
      useNextest,
      steps: [
        {
          command: "cargo",
          args: ["test", "-p", "electivus-apex-log-viewer-cli", "--test", "cli_smoke", "--", "--nocapture"],
          options: baseOptions,
        },
        {
          command: "cargo",
          args: ["test", "-p", "alv-core", "--test", "orgs_smoke", "--", "--nocapture"],
          options: baseOptions,
        },
      ],
    };
  }

  return {
    mode,
    useNextest,
    steps: [
      {
        command: "cargo",
        args: useNextest ? ["nextest", "run", "--workspace"] : ["test", "--workspace"],
        options: baseOptions,
      },
    ],
  };
}

function run(plan, { spawnSyncImpl = spawnSync } = {}) {
  for (const step of plan.steps) {
    console.log(`[rust-tests] ${step.command} ${step.args.join(" ")}`);
    const result = spawnSyncImpl(step.command, step.args, step.options);
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, "..");
  const argv = process.argv.slice(2);
  const env = process.env;
  const nextestAvailable = detectNextest({ env, repoRoot });
  const plan = createRustTestPlan({
    argv,
    env,
    repoRoot,
    nextestAvailable,
  });
  run(plan);
}

module.exports = {
  createRustTestPlan,
  detectNextest,
  prefersNextest,
  run,
};
