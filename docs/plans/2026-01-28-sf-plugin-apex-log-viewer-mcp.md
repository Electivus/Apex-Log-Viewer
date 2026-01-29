# SF Plugin Apex Log Viewer MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a stdio MCP server that exposes `sf apex-log-viewer logs sync` as a single tool and returns the CLI JSON output.

**Architecture:** A small Node + TypeScript package under `apps/sf-plugin-apex-log-viewer-mcp/` with a command layer that normalizes inputs and runs the `sf` binary, plus an MCP server entrypoint that registers the `apexLogsSync` tool over stdio.

**Tech Stack:** Node.js, TypeScript, `@modelcontextprotocol/sdk`, `zod`, Node `child_process`, Node test runner + `tsx` loader.

---

### Task 1: Scaffold the MCP package

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer-mcp/package.json`
- Create: `apps/sf-plugin-apex-log-viewer-mcp/tsconfig.json`
- Create: `apps/sf-plugin-apex-log-viewer-mcp/src/index.ts`
- Create: `apps/sf-plugin-apex-log-viewer-mcp/src/command.ts`
- Create: `apps/sf-plugin-apex-log-viewer-mcp/src/run-sf.ts`

**Step 1: Add package.json**

```json
{
  "name": "@electivus/sf-plugin-apex-log-viewer-mcp",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "bin": {
    "apex-log-viewer-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "node --test --loader tsx",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^<LATEST>",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.12",
    "tsx": "^4.16.2",
    "typescript": "^5.4.5"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

Note: replace `^<LATEST>` with the current `@modelcontextprotocol/sdk` version from npm.

**Step 2: Add tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

**Step 3: Add initial command module (stubbed)**

```ts
export type ApexLogsSyncParams = {
  targetOrg?: string;
  outputDir?: string;
  limit?: number;
};

export type NormalizedParams = {
  targetOrg?: string;
  outputDir: string;
  limit: number;
};

export function normalizeParams(_params: ApexLogsSyncParams, _cwd: string): NormalizedParams {
  throw new Error('Not implemented');
}

export function buildSfArgs(_params: NormalizedParams): string[] {
  throw new Error('Not implemented');
}
```

**Step 4: Add initial runner module (stubbed)**

```ts
export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunSfOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export async function runSfCommand(_args: string[], _options: RunSfOptions): Promise<RunResult> {
  throw new Error('Not implemented');
}

export function parseSfJson(_stdout: string): unknown {
  throw new Error('Not implemented');
}
```

**Step 5: Add index stub**

```ts
console.error('Not implemented');
process.exit(1);
```

**Step 6: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/package.json \
  apps/sf-plugin-apex-log-viewer-mcp/tsconfig.json \
  apps/sf-plugin-apex-log-viewer-mcp/src/index.ts \
  apps/sf-plugin-apex-log-viewer-mcp/src/command.ts \
  apps/sf-plugin-apex-log-viewer-mcp/src/run-sf.ts

git commit -m "chore: scaffold mcp package"
```

---

### Task 2: Param normalization + arg building (TDD)

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer-mcp/test/command.test.ts`
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/src/command.ts`

**Step 1: Write failing tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSfArgs, normalizeParams } from '../src/command.js';

test('normalizeParams defaults and clamps', () => {
  const cwd = '/tmp/work';
  const params = normalizeParams({}, cwd);
  assert.equal(params.limit, 100);
  assert.equal(params.outputDir, path.resolve(cwd, 'apexlogs'));
  assert.equal(params.targetOrg, undefined);
});

test('normalizeParams clamps limit range', () => {
  const cwd = '/tmp/work';
  assert.equal(normalizeParams({ limit: 0 }, cwd).limit, 1);
  assert.equal(normalizeParams({ limit: 500 }, cwd).limit, 200);
});

test('buildSfArgs builds full command', () => {
  const args = buildSfArgs({
    targetOrg: 'my-org',
    outputDir: '/tmp/logs',
    limit: 5
  });
  assert.deepEqual(args, [
    'apex-log-viewer',
    'logs',
    'sync',
    '--json',
    '--target-org',
    'my-org',
    '--output-dir',
    '/tmp/logs',
    '--limit',
    '5'
  ]);
});
```

**Step 2: Run tests to confirm failure**

Run: `npm --prefix apps/sf-plugin-apex-log-viewer-mcp test`
Expected: FAIL with `Not implemented` errors

**Step 3: Implement normalization + args**

```ts
import path from 'node:path';

export type ApexLogsSyncParams = {
  targetOrg?: string;
  outputDir?: string;
  limit?: number;
};

export type NormalizedParams = {
  targetOrg?: string;
  outputDir: string;
  limit: number;
};

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export function normalizeParams(params: ApexLogsSyncParams, cwd: string): NormalizedParams {
  const rawLimit = Number.isFinite(params.limit) ? Math.trunc(params.limit as number) : DEFAULT_LIMIT;
  const clampedLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rawLimit));
  const outputDir = path.resolve(cwd, params.outputDir ?? 'apexlogs');
  const targetOrg = params.targetOrg?.trim() ? params.targetOrg.trim() : undefined;

  return {
    targetOrg,
    outputDir,
    limit: clampedLimit
  };
}

export function buildSfArgs(params: NormalizedParams): string[] {
  const args = ['apex-log-viewer', 'logs', 'sync', '--json'];

  if (params.targetOrg) {
    args.push('--target-org', params.targetOrg);
  }

  if (params.outputDir) {
    args.push('--output-dir', params.outputDir);
  }

  args.push('--limit', String(params.limit));

  return args;
}
```

**Step 4: Run tests to confirm pass**

Run: `npm --prefix apps/sf-plugin-apex-log-viewer-mcp test`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/command.ts \
  apps/sf-plugin-apex-log-viewer-mcp/test/command.test.ts

git commit -m "feat: add command param normalization"
```

---

### Task 3: Runner and JSON parsing (TDD)

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/src/run-sf.ts`
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/test/command.test.ts`

**Step 1: Add failing tests for parsing and runner errors**

```ts
import { parseSfJson } from '../src/run-sf.js';

// ...existing tests...

test('parseSfJson parses JSON output', () => {
  assert.deepEqual(parseSfJson('{"status":0}'), { status: 0 });
});

test('parseSfJson throws on empty output', () => {
  assert.throws(() => parseSfJson(''), /Invalid JSON output/);
});

test('parseSfJson throws on invalid JSON', () => {
  assert.throws(() => parseSfJson('nope'), /Invalid JSON output/);
});
```

**Step 2: Run tests to confirm failure**

Run: `npm --prefix apps/sf-plugin-apex-log-viewer-mcp test`
Expected: FAIL with `Not implemented` errors

**Step 3: Implement runner + parser**

```ts
import { spawn } from 'node:child_process';

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunSfOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export function resolveSfBin(env: NodeJS.ProcessEnv): string {
  const bin = env.SF_BIN?.trim();
  return bin && bin.length > 0 ? bin : 'sf';
}

export async function runSfCommand(args: string[], options: RunSfOptions): Promise<RunResult> {
  const bin = resolveSfBin(options.env);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export function parseSfJson(stdout: string): unknown {
  if (!stdout || stdout.trim().length === 0) {
    throw new Error('Invalid JSON output: empty stdout');
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error('Invalid JSON output: failed to parse');
  }
}
```

**Step 4: Run tests to confirm pass**

Run: `npm --prefix apps/sf-plugin-apex-log-viewer-mcp test`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/run-sf.ts \
  apps/sf-plugin-apex-log-viewer-mcp/test/command.test.ts

git commit -m "feat: add sf runner and json parsing"
```

---

### Task 4: End-to-end command execution function (TDD)

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/src/command.ts`
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/test/command.test.ts`

**Step 1: Add failing tests for runApexLogsSync**

```ts
import { runApexLogsSync } from '../src/command.js';

// ...existing tests...

test('runApexLogsSync returns parsed JSON', async () => {
  const runSf = async () => ({ stdout: '{"status":0}', stderr: '', exitCode: 0 });
  const result = await runApexLogsSync({ limit: 2 }, {
    cwd: '/tmp/work',
    env: {},
    runSf
  });

  assert.deepEqual(result, { status: 0 });
});

test('runApexLogsSync throws on sf failure', async () => {
  const runSf = async () => ({ stdout: '', stderr: 'boom', exitCode: 1 });

  await assert.rejects(
    () => runApexLogsSync({ limit: 2 }, { cwd: '/tmp/work', env: {}, runSf }),
    /sf command failed/
  );
});
```

**Step 2: Run tests to confirm failure**

Run: `npm --prefix apps/sf-plugin-apex-log-viewer-mcp test`
Expected: FAIL with missing export or `Not implemented`

**Step 3: Implement runApexLogsSync**

```ts
import fs from 'node:fs/promises';
import { buildSfArgs, normalizeParams, type ApexLogsSyncParams } from './command.js';
import { parseSfJson, runSfCommand, type RunResult, type RunSfOptions } from './run-sf.js';

export type NormalizedParams = {
  targetOrg?: string;
  outputDir: string;
  limit: number;
};

export type RunSf = (args: string[], options: RunSfOptions) => Promise<RunResult>;

export async function runApexLogsSync(
  params: ApexLogsSyncParams,
  options: { cwd: string; env: NodeJS.ProcessEnv; runSf?: RunSf }
): Promise<unknown> {
  const normalized = normalizeParams(params, options.cwd);
  await fs.mkdir(normalized.outputDir, { recursive: true });

  const args = buildSfArgs(normalized);
  const runSf = options.runSf ?? runSfCommand;
  const result = await runSf(args, { cwd: options.cwd, env: options.env });

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || 'sf command failed';
    throw new Error(`sf command failed: ${message}`);
  }

  return parseSfJson(result.stdout);
}
```

**Step 4: Run tests to confirm pass**

Run: `npm --prefix apps/sf-plugin-apex-log-viewer-mcp test`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/command.ts \
  apps/sf-plugin-apex-log-viewer-mcp/test/command.test.ts

git commit -m "feat: run sf apex logs sync"
```

---

### Task 5: MCP server wiring

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/src/index.ts`

**Step 1: Implement MCP server entrypoint**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runApexLogsSync } from './command.js';

const server = new McpServer({
  name: 'sf-plugin-apex-log-viewer-mcp',
  version: '0.1.0'
});

server.tool(
  'apexLogsSync',
  {
    targetOrg: z.string().optional(),
    outputDir: z.string().optional(),
    limit: z.coerce.number().int().optional()
  },
  async (params) => {
    return runApexLogsSync(params, { cwd: process.cwd(), env: process.env });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: Manual smoke check (no tests)**

Run: `node apps/sf-plugin-apex-log-viewer-mcp/dist/index.js`
Expected: process starts and waits on stdio (no immediate exit)

**Step 3: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/index.ts

git commit -m "feat: add stdio mcp server"
```

---

### Task 6: Add package README

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer-mcp/README.md`

**Step 1: Add README**

```md
# Apex Log Viewer MCP Server

Exposes `sf apex-log-viewer logs sync` as an MCP stdio tool.

## Prerequisites
- `sf` on PATH
- `@electivus/sf-plugin-apex-log-viewer` installed or linked

## Run

```bash
npm --prefix apps/sf-plugin-apex-log-viewer-mcp run build
node apps/sf-plugin-apex-log-viewer-mcp/dist/index.js
```

## Tool

`apexLogsSync` inputs:
- `targetOrg` (string, optional)
- `outputDir` (string, optional, default `./apexlogs`)
- `limit` (number, optional, clamped 1-200)

Returns: JSON output from `sf apex-log-viewer logs sync --json`.
```

**Step 2: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/README.md

git commit -m "docs: add mcp server readme"
```
