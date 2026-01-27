# SF Plugin Apex Log Viewer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `sf apex-log-viewer logs sync` as a TypeScript Salesforce CLI plugin that mirrors the Rust CLI behavior and outputs a new `sf`-style JSON schema.

**Architecture:** Use `SfCommand` from `@salesforce/sf-plugins-core` with `@salesforce/core` for auth, org access, project config, and messages. Implement small libraries for formatting, file naming, and API access; the command orchestrates query + parallel download + output.

**Tech Stack:** TypeScript, oclif (`@salesforce/sf-plugins-core`), `@salesforce/core`, `@salesforce/kit`, Mocha/Chai, `@salesforce/cli-plugins-testkit` (optional NUTs).

---

### Task 1: Scaffold plugin and align metadata

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer/` (generated)
- Modify: `apps/sf-plugin-apex-log-viewer/package.json`
- Modify: `apps/sf-plugin-apex-log-viewer/README.md`

**Step 1: Generate plugin scaffold**
Run:
```
cd /home/k2/git/Apex-Log-Viewer/.worktrees/sf-plugin-apex-log-viewer
mkdir -p apps
cd apps
sf dev generate plugin
```
Use these answers:
- Name: `sf-plugin-apex-log-viewer`
- npm package: `@electivus/sf-plugin-apex-log-viewer`
- Description: `Apex Log Viewer Salesforce CLI plugin`
- Author: `Electivus`
- GitHub repo: `electivus/apex-log-viewer`

Expected: a new folder `apps/sf-plugin-apex-log-viewer/` with `src/`, `messages/`, `test/`, `package.json`.

**Step 2: Verify package metadata**
Edit `apps/sf-plugin-apex-log-viewer/package.json` to ensure:
```json
{
  "name": "@electivus/sf-plugin-apex-log-viewer",
  "private": false,
  "version": "0.1.0"
}
```
Expected: metadata matches plugin name and version.

**Step 3: Smoke test scaffold**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test
```
Expected: tests pass (hello world command).

**Step 4: Commit scaffold**
```
/usr/bin/git add apps/sf-plugin-apex-log-viewer
/usr/bin/git commit -m "chore(sf-plugin): scaffold apex log viewer plugin"
```

---

### Task 2: Add formatting utilities (TDD)

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer/src/lib/time.ts`
- Create: `apps/sf-plugin-apex-log-viewer/src/lib/filename.ts`
- Create: `apps/sf-plugin-apex-log-viewer/test/unit/time.test.ts`
- Create: `apps/sf-plugin-apex-log-viewer/test/unit/filename.test.ts`

**Step 1: Write failing tests**
`apps/sf-plugin-apex-log-viewer/test/unit/time.test.ts`
```ts
import { strict as assert } from 'assert';
import { formatStartTimeUtc } from '../../src/lib/time';

describe('formatStartTimeUtc', () => {
  it('formats StartTime to YYYYMMDDTHHmmssZ', () => {
    const out = formatStartTimeUtc('2024-01-02T03:04:05.000+0000');
    assert.equal(out, '20240102T030405Z');
  });
});
```

`apps/sf-plugin-apex-log-viewer/test/unit/filename.test.ts`
```ts
import { strict as assert } from 'assert';
import { buildLogFilename } from '../../src/lib/filename';

describe('buildLogFilename', () => {
  it('combines start time, username, and logId', () => {
    const name = buildLogFilename('20240102T030405Z', 'user@example.com', '07Lxx0000000001');
    assert.equal(name, '20240102T030405Z_user@example.com_07Lxx0000000001.log');
  });
});
```

**Step 2: Run tests (expect FAIL)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "formatStartTimeUtc|buildLogFilename"
```
Expected: FAIL (modules not found).

**Step 3: Implement minimal code**
`apps/sf-plugin-apex-log-viewer/src/lib/time.ts`
```ts
export const formatStartTimeUtc = (startTime: string): string => {
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid StartTime');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
};
```

`apps/sf-plugin-apex-log-viewer/src/lib/filename.ts`
```ts
export const buildLogFilename = (startTimeUtc: string, username: string, logId: string): string => {
  const safeUser = username.trim() || 'default';
  return `${startTimeUtc}_${safeUser}_${logId}.log`;
};
```

**Step 4: Run tests (expect PASS)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "formatStartTimeUtc|buildLogFilename"
```
Expected: PASS.

**Step 5: Commit**
```
/usr/bin/git add apps/sf-plugin-apex-log-viewer/src/lib apps/sf-plugin-apex-log-viewer/test/unit
/usr/bin/git commit -m "feat(sf-plugin): add time and filename helpers"
```

---

### Task 3: Add limit clamp and concurrency helper (TDD)

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer/src/lib/limits.ts`
- Create: `apps/sf-plugin-apex-log-viewer/src/lib/concurrency.ts`
- Create: `apps/sf-plugin-apex-log-viewer/test/unit/limits.test.ts`
- Create: `apps/sf-plugin-apex-log-viewer/test/unit/concurrency.test.ts`

**Step 1: Write failing tests**
`apps/sf-plugin-apex-log-viewer/test/unit/limits.test.ts`
```ts
import { strict as assert } from 'assert';
import { clampLimit } from '../../src/lib/limits';

describe('clampLimit', () => {
  it('clamps to 1..200', () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(201), 200);
    assert.equal(clampLimit(50), 50);
  });
});
```

`apps/sf-plugin-apex-log-viewer/test/unit/concurrency.test.ts`
```ts
import { strict as assert } from 'assert';
import { runWithConcurrency } from '../../src/lib/concurrency';

describe('runWithConcurrency', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    await runWithConcurrency(items, 2, async (n) => {
      seen.push(n);
    });
    assert.deepEqual(seen.sort(), items);
  });
});
```

**Step 2: Run tests (expect FAIL)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "clampLimit|runWithConcurrency"
```
Expected: FAIL.

**Step 3: Implement minimal code**
`apps/sf-plugin-apex-log-viewer/src/lib/limits.ts`
```ts
export const clampLimit = (value: number): number => Math.min(200, Math.max(1, value));
```

`apps/sf-plugin-apex-log-viewer/src/lib/concurrency.ts`
```ts
export const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> => {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
};
```

**Step 4: Run tests (expect PASS)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "clampLimit|runWithConcurrency"
```
Expected: PASS.

**Step 5: Commit**
```
/usr/bin/git add apps/sf-plugin-apex-log-viewer/src/lib apps/sf-plugin-apex-log-viewer/test/unit
/usr/bin/git commit -m "feat(sf-plugin): add limit and concurrency helpers"
```

---

### Task 4: Add Salesforce API helpers (TDD)

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer/src/lib/api.ts`
- Create: `apps/sf-plugin-apex-log-viewer/src/lib/types.ts`
- Create: `apps/sf-plugin-apex-log-viewer/test/unit/api.test.ts`

**Step 1: Write failing tests**
`apps/sf-plugin-apex-log-viewer/test/unit/api.test.ts`
```ts
import { strict as assert } from 'assert';
import { queryApexLogs } from '../../src/lib/api';

const fakeConn: any = {
  tooling: {
    query: async () => ({ records: [{ Id: '07L1', StartTime: '2024-01-02T03:04:05.000+0000', LogLength: 12, LogUser: { Username: 'u' } }] })
  }
};

describe('queryApexLogs', () => {
  it('returns records from tooling query', async () => {
    const res = await queryApexLogs(fakeConn, 1);
    assert.equal(res.length, 1);
    assert.equal(res[0].id, '07L1');
  });
});
```

**Step 2: Run test (expect FAIL)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "queryApexLogs"
```
Expected: FAIL.

**Step 3: Implement minimal code**
`apps/sf-plugin-apex-log-viewer/src/lib/types.ts`
```ts
export type ApexLogRecord = {
  id: string;
  startTime: string;
  logLength: number;
  username: string;
};
```

`apps/sf-plugin-apex-log-viewer/src/lib/api.ts`
```ts
import type { Connection } from '@salesforce/core';
import type { ApexLogRecord } from './types';

export const queryApexLogs = async (conn: Connection, limit: number): Promise<ApexLogRecord[]> => {
  const soql = `SELECT Id, StartTime, LogLength, LogUser.Username FROM ApexLog ORDER BY StartTime DESC LIMIT ${limit}`;
  const res = await conn.tooling.query(soql);
  return res.records.map((record: any) => ({
    id: record.Id,
    startTime: record.StartTime,
    logLength: record.LogLength,
    username: record.LogUser?.Username ?? 'default'
  }));
};

export const fetchApexLogBody = async (conn: Connection, logId: string): Promise<string> => {
  const url = `/services/data/v${conn.getApiVersion()}/tooling/sobjects/ApexLog/${logId}/Body`;
  return conn.request<string>(url);
};
```

**Step 4: Run test (expect PASS)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "queryApexLogs"
```
Expected: PASS.

**Step 5: Commit**
```
/usr/bin/git add apps/sf-plugin-apex-log-viewer/src/lib apps/sf-plugin-apex-log-viewer/test/unit
/usr/bin/git commit -m "feat(sf-plugin): add apex log api helpers"
```

---

### Task 5: Implement `logs sync` command (TDD)

**Files:**
- Create: `apps/sf-plugin-apex-log-viewer/src/commands/apex-log-viewer/logs/sync.ts`
- Create: `apps/sf-plugin-apex-log-viewer/messages/apex-log-viewer.logs.sync.md`
- Create: `apps/sf-plugin-apex-log-viewer/test/unit/commands/logs.sync.test.ts`

**Step 1: Write failing test**
`apps/sf-plugin-apex-log-viewer/test/unit/commands/logs.sync.test.ts`
```ts
import { strict as assert } from 'assert';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { TestContext } from '@salesforce/core/lib/testSetup';
import LogsSync from '../../../src/commands/apex-log-viewer/logs/sync';

const $$ = new TestContext();

describe('apex-log-viewer logs sync', () => {
  it('returns json schema', async () => {
    const ux = stubSfCommandUx($$.SANDBOX);
    const result = await LogsSync.run(['--json']);
    assert.ok(result);
    assert.equal((result as any).status, 0);
    assert.ok((result as any).result);
    ux.table.reset();
  });
});
```

**Step 2: Run test (expect FAIL)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "logs sync"
```
Expected: FAIL (command not found).

**Step 3: Implement minimal command**
`apps/sf-plugin-apex-log-viewer/messages/apex-log-viewer.logs.sync.md`
```md
# summary

Sync Apex logs to a local folder.

# description

Downloads recent Apex logs from the target org and writes them to disk.

# flags.target-org.summary

Username or alias for the target org.

# flags.output-dir.summary

Directory to write logs into.

# flags.limit.summary

Maximum number of logs to fetch (1-200).

# error.NoSourceApiVersion

Missing sourceApiVersion in sfdx-project.json.

# error.NoProject

Run this command inside a Salesforce project.
```

`apps/sf-plugin-apex-log-viewer/src/commands/apex-log-viewer/logs/sync.ts`
```ts
import { SfCommand, Flags, optionalOrgFlag } from '@salesforce/sf-plugins-core';
import { Messages, SfProject } from '@salesforce/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { formatStartTimeUtc } from '../../../lib/time';
import { buildLogFilename } from '../../../lib/filename';
import { clampLimit } from '../../../lib/limits';
import { runWithConcurrency } from '../../../lib/concurrency';
import { fetchApexLogBody, queryApexLogs } from '../../../lib/api';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@electivus/sf-plugin-apex-log-viewer', 'apex-log-viewer.logs.sync');

type JsonResult = {
  status: 0;
  result: {
    org: { username?: string; instanceUrl: string };
    apiVersion: string;
    limit: number;
    outputDir: string;
    logsSaved: Array<{ id: string; file: string; size: number }>;
    logsSkipped: Array<{ id: string; reason: string }>;
    errors: Array<{ id?: string; message: string }>;
  };
};

export default class LogsSync extends SfCommand<JsonResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly flags = {
    'target-org': optionalOrgFlag({ summary: messages.getMessage('flags.target-org.summary'), char: 'o' }),
    'output-dir': Flags.directory({ summary: messages.getMessage('flags.output-dir.summary'), char: 'd' }),
    limit: Flags.integer({ summary: messages.getMessage('flags.limit.summary'), char: 'l', min: 1, max: 200, default: 100 })
  };
  public static readonly requiresProject = true;

  public async run(): Promise<JsonResult> {
    const { flags } = await this.parse(LogsSync);

    const project = await SfProject.getInstance();
    const apiVersion = project.getProjectConfig().sourceApiVersion;
    if (!apiVersion) {
      throw messages.createError('error.NoSourceApiVersion');
    }

    const org = flags['target-org']?.getOrg() ?? (await this.org);
    const conn = org.getConnection();
    const limit = clampLimit(flags.limit ?? 100);
    const outputDir = flags['output-dir'] ?? 'apexlogs';

    await fs.mkdir(outputDir, { recursive: true });

    const logs = await queryApexLogs(conn, limit);
    const logsSaved: JsonResult['result']['logsSaved'] = [];
    const logsSkipped: JsonResult['result']['logsSkipped'] = [];
    const errors: JsonResult['result']['errors'] = [];

    await runWithConcurrency(logs, 5, async (log) => {
      try {
        const startTime = formatStartTimeUtc(log.startTime);
        const filename = buildLogFilename(startTime, log.username, log.id);
        const body = await fetchApexLogBody(conn, log.id);
        const filePath = path.join(outputDir, filename);
        await fs.writeFile(filePath, body, 'utf8');
        logsSaved.push({ id: log.id, file: filePath, size: body.length });
      } catch (err: any) {
        errors.push({ id: log.id, message: String(err?.message ?? err) });
      }
    });

    if (!flags.json) {
      this.ux.table(
        logs.map((log) => ({
          StartTime: log.startTime,
          User: log.username,
          LogId: log.id,
          Size: log.logLength,
          File: logsSaved.find((s) => s.id === log.id)?.file ?? ''
        })),
        { StartTime: {}, User: {}, LogId: {}, Size: {}, File: {} }
      );
      this.log(`Saved: ${logsSaved.length}, Skipped: ${logsSkipped.length}, Errors: ${errors.length}`);
    }

    return {
      status: 0,
      result: {
        org: { username: org.getUsername(), instanceUrl: conn.instanceUrl },
        apiVersion,
        limit,
        outputDir,
        logsSaved,
        logsSkipped,
        errors
      }
    };
  }
}
```

**Step 4: Run test (expect PASS)**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test -- --grep "logs sync"
```
Expected: PASS.

**Step 5: Commit**
```
/usr/bin/git add apps/sf-plugin-apex-log-viewer/src apps/sf-plugin-apex-log-viewer/messages apps/sf-plugin-apex-log-viewer/test/unit
/usr/bin/git commit -m "feat(sf-plugin): add logs sync command"
```

---

### Task 6: Docs and changelog

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `apps/sf-plugin-apex-log-viewer/README.md`

**Step 1: Update plugin README**
Add usage example:
```
sf apex-log-viewer logs sync --target-org myOrg --limit 100 --output-dir apexlogs
```

**Step 2: Update root README**
Add a new section for the `sf` plugin with install instructions:
```
sf plugins install @electivus/sf-plugin-apex-log-viewer
```

**Step 3: Update CHANGELOG**
Add an entry under Unreleased:
```
- Added Salesforce CLI plugin: `sf apex-log-viewer logs sync`.
```

**Step 4: Commit docs**
```
/usr/bin/git add README.md CHANGELOG.md apps/sf-plugin-apex-log-viewer/README.md
/usr/bin/git commit -m "docs: add sf plugin usage"
```

---

### Task 7: Full test pass (baseline)

**Step 1: Run plugin unit tests**
Run:
```
npm --prefix apps/sf-plugin-apex-log-viewer test
```
Expected: PASS.

**Step 2: Run repo unit suite**
Run:
```
npm run ext:test:unit
```
Expected: PASS.

---

**Plan complete and saved to `docs/plans/2026-01-27-sf-plugin-apex-log-viewer.md`. Two execution options:**

1. Subagent-Driven (this session) — I dispatch fresh subagent per task, review between tasks.
2. Parallel Session (separate) — Open new session with executing-plans, batch execution with checkpoints.

Which approach?
