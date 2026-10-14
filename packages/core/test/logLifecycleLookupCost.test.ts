import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApexLogLifecycle, type ApexLogRef, type ApexLogRemote } from '../src/index.ts';

const DAY_COUNT = 60;
const CANONICAL_COUNT = 100;
const LEGACY_COUNT = 20;

const COUNTED_METHODS = [
  'access',
  'appendFile',
  'copyFile',
  'link',
  'lstat',
  'mkdir',
  'open',
  'readFile',
  'readdir',
  'realpath',
  'rename',
  'rm',
  'stat',
  'unlink',
  'writeFile'
] as const;

type CountedMethod = (typeof COUNTED_METHODS)[number];

type FsCallCounts = Readonly<{
  total: number;
  byMethod: Readonly<Partial<Record<CountedMethod, number>>>;
  logBodyReads: number;
}>;

type SyntheticStore = Readonly<{
  workspaceRoot: string;
  username: string;
  days: readonly string[];
  canonical: readonly ApexLogRef[];
  legacy: readonly ApexLogRef[];
}>;

const offlineRemote: ApexLogRemote = {
  async resolveOrg() {
    throw new Error('Salesforce must not be consulted');
  },
  async listLogs() {
    throw new Error('Salesforce must not be consulted');
  },
  async readBody() {
    throw new Error('Salesforce must not be consulted');
  }
};

function logIdFor(index: number): string {
  return `07L${String(index).padStart(12, '0')}AAA`;
}

function dayOf(log: ApexLogRef): string {
  return String(log.startTime).slice(0, 10);
}

async function countFsCalls<T>(run: () => Promise<T>): Promise<{ result: T; counts: FsCallCounts }> {
  const byMethod: Partial<Record<CountedMethod, number>> = {};
  let logBodyReads = 0;
  const target = fs as unknown as Record<CountedMethod, (...args: unknown[]) => unknown>;
  const originals = new Map<CountedMethod, (...args: unknown[]) => unknown>();
  for (const name of COUNTED_METHODS) {
    const original = target[name];
    originals.set(name, original);
    target[name] = function counted(...args: unknown[]) {
      byMethod[name] = (byMethod[name] ?? 0) + 1;
      if (name === 'readFile' && String(args[0]).endsWith('.log')) logBodyReads += 1;
      return original.apply(fs, args);
    };
  }
  try {
    const result = await run();
    const total = Object.values(byMethod).reduce((sum, count) => sum + (count ?? 0), 0);
    return { result, counts: { total, byMethod, logBodyReads } };
  } finally {
    for (const [name, original] of originals) target[name] = original;
  }
}

async function buildSyntheticStore(): Promise<SyntheticStore> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-lookup-cost-'));
  const username = 'cost@example.com';
  const orgRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', username);
  const days = Array.from({ length: DAY_COUNT }, (_, index) =>
    new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10)
  );
  for (const day of days) await fs.mkdir(path.join(orgRoot, 'logs', day), { recursive: true });
  await fs.writeFile(path.join(orgRoot, 'org.json'), `${JSON.stringify({ version: 1, username })}\n`, 'utf8');

  const canonical = Array.from({ length: CANONICAL_COUNT }, (_, index) => ({
    logId: logIdFor(index),
    startTime: `${days[index % DAY_COUNT]}T12:00:00.000Z`
  }));
  for (const log of canonical) {
    await fs.writeFile(path.join(orgRoot, 'logs', dayOf(log), `${log.logId}.log`), `body ${log.logId}\n`, 'utf8');
  }

  const legacy = Array.from({ length: LEGACY_COUNT }, (_, index) => ({
    logId: logIdFor(CANONICAL_COUNT + index),
    startTime: `${days[index]}T12:00:00.000Z`
  }));
  for (const log of legacy) {
    await fs.writeFile(
      path.join(workspaceRoot, 'apexlogs', `${username}_${log.logId}.log`),
      `legacy ${log.logId}\n`,
      'utf8'
    );
  }
  return { workspaceRoot, username, days, canonical, legacy };
}

function canonicalPath(store: SyntheticStore, log: ApexLogRef): string {
  return path.join(store.workspaceRoot, 'apexlogs', 'orgs', store.username, 'logs', dayOf(log), `${log.logId}.log`);
}

test('availableLocalPaths lookup cost over a 100-log page', async t => {
  await t.test('page of canonical hits with known start days', async subtest => {
    const store = await buildSyntheticStore();
    const lifecycle = createApexLogLifecycle({ remote: offlineRemote });
    try {
      const { result, counts } = await countFsCalls(() =>
        lifecycle.availableLocalPaths({
          workspaceRoot: store.workspaceRoot,
          targetOrg: store.username,
          logs: store.canonical
        })
      );
      subtest.diagnostic(`fs calls ${JSON.stringify(counts)}`);

      assert.deepEqual(
        result.available.map(file => file.localPath),
        store.canonical.map(log => canonicalPath(store, log))
      );
      assert.deepEqual(new Set(result.available.map(file => file.persistence)), new Set(['existing']));
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.failures, []);
      assert.equal(counts.logBodyReads, 0);
      assert.equal(counts.total, 168);
    } finally {
      lifecycle.dispose();
      await fs.rm(store.workspaceRoot, { recursive: true, force: true });
    }
  });

  await t.test('page of 80 canonical hits and 20 legacy logs to migrate', async subtest => {
    const store = await buildSyntheticStore();
    const lifecycle = createApexLogLifecycle({ remote: offlineRemote });
    try {
      const page = [...store.canonical.slice(0, 80), ...store.legacy];
      const { result, counts } = await countFsCalls(() =>
        lifecycle.availableLocalPaths({ workspaceRoot: store.workspaceRoot, targetOrg: store.username, logs: page })
      );
      subtest.diagnostic(`fs calls ${JSON.stringify(counts)}`);

      assert.deepEqual(
        result.available.map(file => file.localPath),
        page.map(log => canonicalPath(store, log))
      );
      assert.deepEqual(
        result.available.map(file => file.persistence),
        [...Array.from({ length: 80 }, () => 'existing'), ...Array.from({ length: 20 }, () => 'written')]
      );
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.failures, []);
      for (const log of store.legacy) {
        assert.equal(await fs.readFile(canonicalPath(store, log), 'utf8'), `legacy ${log.logId}\n`);
        assert.equal(
          await fs.readFile(path.join(store.workspaceRoot, 'apexlogs', `${store.username}_${log.logId}.log`), 'utf8'),
          `legacy ${log.logId}\n`
        );
      }
      assert.equal(counts.logBodyReads, 20);
      assert.equal(counts.total, 509);
    } finally {
      lifecycle.dispose();
      await fs.rm(store.workspaceRoot, { recursive: true, force: true });
    }
  });

  await t.test('page of 80 canonical hits and 20 logs never synced', async subtest => {
    const store = await buildSyntheticStore();
    const lifecycle = createApexLogLifecycle({ remote: offlineRemote });
    try {
      const unsynced = Array.from({ length: 20 }, (_, index) => ({
        logId: logIdFor(CANONICAL_COUNT + LEGACY_COUNT + index),
        startTime: `${store.days[index]}T12:00:00.000Z`
      }));
      const page = [...store.canonical.slice(0, 80), ...unsynced];
      const { result, counts } = await countFsCalls(() =>
        lifecycle.availableLocalPaths({ workspaceRoot: store.workspaceRoot, targetOrg: store.username, logs: page })
      );
      subtest.diagnostic(`fs calls ${JSON.stringify(counts)}`);

      assert.deepEqual(
        result.available.map(file => file.localPath),
        store.canonical.slice(0, 80).map(log => canonicalPath(store, log))
      );
      assert.deepEqual(result.missing, unsynced);
      assert.deepEqual(result.failures, []);
      assert.equal(counts.logBodyReads, 0);
      assert.equal(counts.total, 249);
    } finally {
      lifecycle.dispose();
      await fs.rm(store.workspaceRoot, { recursive: true, force: true });
    }
  });
});
