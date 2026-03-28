const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(repoRoot, "apps", "vscode-extension", "src", "test", "fixtures", "eslintTypeAware.fixture.ts");

test("repo ESLint config reports floating promises in TypeScript files", async () => {
  const { ESLint } = require("eslint");
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, "eslint.config.mjs"),
    ignore: false,
  });

  const [result] = await eslint.lintFiles([fixturePath]);
  const floatingPromiseMessage = result.messages.find(
    (message) => message.ruleId === "@typescript-eslint/no-floating-promises",
  );

  assert.ok(
    floatingPromiseMessage,
    `Expected @typescript-eslint/no-floating-promises, got ${JSON.stringify(result.messages, null, 2)}`,
  );
});
