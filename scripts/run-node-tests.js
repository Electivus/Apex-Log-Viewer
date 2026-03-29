"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { transformSync } = require("esbuild");
const Mocha = require("mocha");

function collectTests(dir, acc = []) {
  if (!fs.existsSync(dir)) {
    return acc;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTests(entryPath, acc);
    } else if (/\.test\.ts$/.test(entry.name)) {
      acc.push(entryPath);
    }
  }
  return acc;
}

function registerTypeScriptLoader(repoRoot) {
  const previousTs = require.extensions[".ts"];
  const previousTsx = require.extensions[".tsx"];

  const compile = (module, filename) => {
    const normalizedFilename = path.normalize(filename);
    const normalizedRepoRoot = path.normalize(repoRoot) + path.sep;
    const withinRepo = normalizedFilename.startsWith(normalizedRepoRoot);
    if (!withinRepo || normalizedFilename.includes(`${path.sep}node_modules${path.sep}`)) {
      if (filename.endsWith(".tsx") && previousTsx) {
        previousTsx(module, filename);
        return;
      }
      if (previousTs) {
        previousTs(module, filename);
        return;
      }
      throw new Error(`No loader available for ${filename}`);
    }

    const source = fs.readFileSync(filename, "utf8");
    const loader = filename.endsWith(".tsx") ? "tsx" : "ts";
    const { code } = transformSync(source, {
      loader,
      format: "cjs",
      target: "es2022",
      sourcemap: "inline",
      sourcefile: filename,
      tsconfigRaw: {
        compilerOptions: {
          jsx: "react-jsx",
        },
      },
    });

    module._compile(code, filename);
  };

  require.extensions[".ts"] = compile;
  require.extensions[".tsx"] = compile;
}

async function run() {
  const repoRoot = path.resolve(__dirname, "..");
  const testsRoot = path.join(repoRoot, "apps", "vscode-extension", "src", "node-test");
  registerTypeScriptLoader(repoRoot);

  const timeout = Number(process.env.NODE_TEST_MOCHA_TIMEOUT_MS || process.env.VSCODE_TEST_MOCHA_TIMEOUT_MS || 30000);
  const grep = process.env.NODE_TEST_GREP;
  const invert = /^(1|true)$/i.test(String(process.env.NODE_TEST_INVERT || ""));
  const fullTrace = /^(1|true)$/i.test(String(process.env.NODE_TEST_MOCHA_FULLTRACE || ""));

  const files = collectTests(testsRoot);
  if (files.length === 0) {
    throw new Error(`No Node-only extension tests found under ${testsRoot}`);
  }

  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout,
    reporter: "spec",
    forbidOnly: true,
    fullTrace,
  });

  if (grep) {
    mocha.grep(grep);
    if (invert) {
      mocha.invert();
    }
  }

  files.forEach((file) => mocha.addFile(file));

  await new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} node test(s) failed.`));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  collectTests,
  registerTypeScriptLoader,
  run,
};
