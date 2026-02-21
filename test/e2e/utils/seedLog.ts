import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runSfJson } from './sfCli';
import { ensureE2eTraceFlag, getOrgAuth } from './tooling';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type SeedResult = {
  marker: string;
  logId: string;
};

function parseLogIds(listResult: any): string[] {
  const rows = listResult?.result || listResult?.records || listResult;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((r: any) => r?.Id).filter((v: any): v is string => typeof v === 'string' && v.length > 0);
}

export async function seedApexLog(targetOrg: string): Promise<SeedResult> {
  const auth = await getOrgAuth(targetOrg);
  await ensureE2eTraceFlag(auth);

  const before = await runSfJson(['apex', 'list', 'log', '-o', targetOrg]);
  const beforeIds = new Set(parseLogIds(before));

  const marker = `ALV_E2E_MARKER_${Date.now()}`;
  await runAnonymousApex(targetOrg, `System.debug('${marker}');\n`);
  const logId = await waitForCreatedLogId(targetOrg, beforeIds);
  return { marker, logId };
}

export async function seedApexErrorLog(targetOrg: string): Promise<SeedResult> {
  const auth = await getOrgAuth(targetOrg);
  await ensureE2eTraceFlag(auth);

  const before = await runSfJson(['apex', 'list', 'log', '-o', targetOrg]);
  const beforeIds = new Set(parseLogIds(before));

  const marker = `ALV_E2E_ERROR_MARKER_${Date.now()}`;
  const anonymousApex =
    `System.debug('${marker}');\n` +
    'try {\n' +
    '  Object alvFail = null;\n' +
    '  System.debug(alvFail.toString());\n' +
    '} catch (Exception e) {\n' +
    "  System.debug('ALV_E2E_ERROR_CAUGHT:' + e.getMessage());\n" +
    '}\n';
  // Generate a real log with EXCEPTION_* events but keep the anonymous Apex run successful.
  await runAnonymousApex(targetOrg, anonymousApex);
  const logId = await waitForCreatedLogId(targetOrg, beforeIds);
  return { marker, logId };
}

async function runAnonymousApex(targetOrg: string, anonymousApex: string, options?: { allowFailure?: boolean }): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'alv-apex-'));
  const apexFile = path.join(tmp, 'seed.apex');
  await writeFile(apexFile, anonymousApex, 'utf8');
  try {
    try {
      await runSfJson(['apex', 'run', '-o', targetOrg, '--file', apexFile]);
    } catch (e) {
      if (!options?.allowFailure) {
        throw e;
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function waitForCreatedLogId(targetOrg: string, beforeIds: Set<string>): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const after = await runSfJson(['apex', 'list', 'log', '-o', targetOrg]);
    const afterIds = parseLogIds(after);
    const created = afterIds.find(id => !beforeIds.has(id));
    if (created) {
      return created;
    }
    await sleep(2_000);
  }
  throw new Error('Failed to detect a newly created ApexLog after seeding anonymous Apex.');
}
