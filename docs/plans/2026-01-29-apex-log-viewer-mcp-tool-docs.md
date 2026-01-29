# Apex Log Viewer MCP Tool Docs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add LLM-friendly tool descriptions/instructions in the MCP tool schema and README.

**Architecture:** Extend the MCP tool registration with `title`, `description`, and `annotations` + optional output schema. Update README with a clear “LLM Usage” section and examples for agents.

**Tech Stack:** TypeScript (NodeNext), node:test, Markdown.

---

### Task 1: Add tool metadata + schema in server

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/src/server.ts`
- Test: `apps/sf-plugin-apex-log-viewer-mcp/test/server.test.ts`

**Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('apexLogsSync tool includes title/description/annotations', async () => {
  const server = createServer();
  const tools = await server.listTools();
  const tool = tools.tools.find((t) => t.name === 'apexLogsSync');

  assert.ok(tool?.description?.includes('Apex log files'));
  assert.ok(tool?.title?.includes('Apex Log Viewer'));
  assert.equal(tool?.annotations?.readOnlyHint, true);
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
node --test --import tsx apps/sf-plugin-apex-log-viewer-mcp/test/server.test.ts
```
Expected: FAIL (metadata not set)

**Step 3: Write minimal implementation**

```ts
server.tool(
  'apexLogsSync',
  {
    title: 'Apex Log Viewer: Sync Logs',
    description: 'Syncs Apex log files from a Salesforce org to a local folder using the sf plugin.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      // existing zod schema
    }
  },
  async (params) => { /* existing handler */ }
);
```

**Step 4: Run test to verify it passes**

Run:
```bash
node --test --import tsx apps/sf-plugin-apex-log-viewer-mcp/test/server.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/src/server.ts apps/sf-plugin-apex-log-viewer-mcp/test/server.test.ts
git commit -m "docs(mcp): add tool metadata"
```

---

### Task 2: Expand README with LLM usage guidance

**Files:**
- Modify: `apps/sf-plugin-apex-log-viewer-mcp/README.md`

**Step 1: Update README**

Add a new section, e.g.:

```md
## LLM / Agent Usage

### Tool name
- `apexLogsSync`

### When to use
- Sync Apex logs for local inspection or debugging.

### Inputs
- `targetOrg` (string, optional): username or alias.
- `outputDir` (string, optional): directory to write logs. Defaults to `./apexlogs` relative to server cwd.
- `limit` (number, optional): max logs to sync. Clamped 1–200.

### Behavior
- Creates the output directory if missing.
- Runs: `sf apex-log-viewer logs sync --json`.
- Returns JSON in `structuredContent`.

### Example
```json
{"tool":"apexLogsSync","args":{"targetOrg":"my-org","outputDir":"/tmp/apexlogs","limit":50}}
```
```

**Step 2: Commit**

```bash
git add apps/sf-plugin-apex-log-viewer-mcp/README.md
git commit -m "docs(mcp): add llm usage guide"
```

---

## Notes
- Keep descriptions concise and action-oriented per MCP spec.
- Use `annotations` hints to help agent planners.
