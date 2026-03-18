import { timeE2eStep } from './timing';
import { clearApexLogsForE2E, ensureE2eTraceFlag, executeAnonymousApex, findRecentApexLogId, getOrgAuth } from './tooling';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type SeedResult = {
  marker: string;
  logId: string;
};

export async function seedApexLog(targetOrg: string): Promise<SeedResult> {
  return await timeE2eStep('seed.log', async () => {
    const auth = await getOrgAuth(targetOrg);
    await ensureE2eTraceFlag(auth);

    const marker = `ALV_E2E_MARKER_${Date.now()}`;
    const startedAtMs = Date.now();
    await runAnonymousApex(auth, `System.debug('${marker}');\n`);
    const logId = await waitForCreatedLogId(auth, startedAtMs, marker);
    return { marker, logId };
  });
}

export async function clearOrgApexLogs(targetOrg: string, scope: 'all' | 'mine' = 'all'): Promise<void> {
  await timeE2eStep(`seed.clearLogs:${scope}`, async () => {
    const auth = await getOrgAuth(targetOrg);
    await clearApexLogsForE2E(auth, scope);
  });
}

export async function seedApexErrorLog(targetOrg: string): Promise<SeedResult> {
  return await timeE2eStep('seed.errorLog', async () => {
    const auth = await getOrgAuth(targetOrg);
    await ensureE2eTraceFlag(auth);

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
    const startedAtMs = Date.now();
    await runAnonymousApex(auth, anonymousApex);
    const logId = await waitForCreatedLogId(auth, startedAtMs, marker);
    return { marker, logId };
  });
}

async function runAnonymousApex(
  auth: Awaited<ReturnType<typeof getOrgAuth>>,
  anonymousApex: string,
  options?: { allowFailure?: boolean }
): Promise<void> {
  await timeE2eStep('seed.runAnonymousApex', async () => {
    await executeAnonymousApex(auth, anonymousApex, options);
  });
}

async function waitForCreatedLogId(
  auth: Awaited<ReturnType<typeof getOrgAuth>>,
  startedAtMs: number,
  marker: string
): Promise<string> {
  return await timeE2eStep('seed.waitForCreatedLogId', async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const created = await findRecentApexLogId(auth, startedAtMs, marker);
      if (created) {
        return created;
      }
      await sleep(300);
    }
    throw new Error('Failed to detect a newly created ApexLog after seeding anonymous Apex.');
  });
}
