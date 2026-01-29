# Apex Log Viewer MCP CLI Wrapper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a CLI wrapper with `--project-dir` and startup logs so developers can launch the MCP server predictably.

**Architecture:** Introduce `apps/sf-plugin-apex-log-viewer-mcp/src/cli.ts` with argument parsing and a `runCli` that spawns the stdio server (`dist/index.js`) using `process.execPath`, applying cwd/env overrides. Keep MCP server runtime logic untouched.

**Tech Stack:** TypeScript (NodeNext), node:test, tsx.

---

### Task 1: CLI argument parsing + usage output

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer-mcp/src/cli.ts`
- Create: `apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts`

**Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('parseArgs: --help toggles showHelp', () => {
  const result = parseArgs(['--help']);
  assert.equal(result.showHelp, true);
  assert.equal(result.error, undefined);
});

test('parseArgs: unknown flag returns error', () => {
  const result = parseArgs(['--nope']);
  assert.ok(result.error?.includes('Unknown argument'));
});

test('parseArgs: --project-dir requires value', () => {
  const result = parseArgs(['--project-dir']);
  assert.ok(result.error?.includes('--project-dir'));
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
node --test --import tsx apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts
```
Expected: FAIL (parseArgs not found / not implemented)

**Step 3: Write minimal implementation**

```ts
export type CliParseResult = {
  options: { projectDir?: string; sfBin?: string; debug?: boolean };
  showHelp?: boolean;
  showVersion?: boolean;
  error?: string;
};

export function parseArgs(argv: string[]): CliParseResult {
  // parse --help/-h, --version, --project-dir, --sf-bin, --debug
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
node --test --import tsx apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/cli.ts apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts
git commit -m "feat(mcp): add cli arg parsing"
```

---

### Task 2: CLI runner (spawn) + startup logs

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/src/cli.ts`
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts`

**Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCli } from '../src/cli.js';

test('runCli: sets cwd and spawns server', async () => {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>=[];

  const result = await runCli(
    ['--project-dir', '/tmp/proj', '--sf-bin', '/usr/local/bin/sf'],
    {
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
        return { once: (_: string, cb: () => void) => cb() } as any;
      },
      chdir: () => {},
      log: () => {},
      exit: () => {}
    }
  );

  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(path.basename(calls[0].args[0]).includes('index.js'));
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
node --test --import tsx apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts
```
Expected: FAIL (runCli not implemented)

**Step 3: Write minimal implementation**

```ts
export async function runCli(argv: string[], deps = defaultDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.showHelp) { /* print usage */ return 0; }
  if (parsed.error) { /* print error + usage */ return 1; }

  if (parsed.options.projectDir) deps.chdir(parsed.options.projectDir);
  if (parsed.options.sfBin) process.env.SF_BIN = parsed.options.sfBin;

  deps.log(/* startup info to stderr */);

  const entry = resolveServerEntry(); // dist/index.js
  const child = deps.spawn(process.execPath, [entry], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  return await waitForExit(child);
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
node --test --import tsx apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/cli.ts apps/sf-plugin-apex-log-viewer-mcp/test/cli.test.ts
git commit -m "feat(mcp): add cli runner"
```

---

### Task 3: Wire CLI entry + docs

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/package.json`
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/README.md`

**Step 1: Update bin entry**

```json
"bin": {
  "apex-log-viewer-mcp": "dist/cli.js"
}
```

**Step 2: Update README usage**

Add quick-start examples:
```bash
apex-log-viewer-mcp --project-dir /path/to/project --sf-bin /path/to/sf
```

**Step 3: Run tests**

Run:
```bash
npm --prefix apps/sf-plugin-apex-log-viewer-mcp test
```
Expected: PASS

**Step 4: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/package.json apps/sf-plugin-apex-log-viewer-mcp/README.md
git commit -m "docs(mcp): document cli usage"
```

---

## Notes
- After implementation, run `npm --prefix apps/sf-plugin-apex-log-viewer-mcp run build` to regenerate `dist/`.
- Keep all CLI output on stderr to avoid interfering with stdio MCP.
