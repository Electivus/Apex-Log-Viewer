const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("xvfb re-exec preserves original CLI flags", () => {
  const script = fs.readFileSync(path.join(__dirname, "run-tests.js"), "utf8");

  assert.match(
    script,
    /spawn\('xvfb-run', \[[\s\S]*process\.execPath,\s*__filename,\s*\.\.\.process\.argv\.slice\(2\)/,
  );
});
