import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { timeE2eStep } from './timing';
import {
  clearApexLogsForE2E,
  ensureE2eTraceFlag,
  executeAnonymousApex,
  findRecentApexLogId,
  getOrgAuth,
  type OrgAuth
} from './tooling';

export const DOCS_SEARCH_QUERY = 'policy renewal';
export const DOCS_TAIL_SEARCH_QUERY = 'tail live renewal';
export const DOCS_TAIL_ALERT_LINE = 'Tail live renewal alert published to the case review channel';

export const DOCS_CUSTOM_LOGS_FILTER = 'http.status >= 500';

const DOCS_CUSTOM_LOG_TAG = 'ALVDOCS';

export const DOCS_CUSTOM_LOG_SOURCE = {
  id: 'docs-app-logs',
  label: 'Application logs',
  entry: {
    object: 'Account',
    fields: {
      time: 'CreatedDate',
      message: 'Name',
      level: 'Rating',
      user: 'CreatedBy.Username'
    },
    payload: { field: 'Description', columns: ['policyId', 'http.status', 'durationMs'] }
  },
  levels: { Hot: 'ERROR', Warm: 'WARN', Cold: 'INFO' }
};

type DocsCustomLogRow = { message: string; rating: 'Hot' | 'Warm' | 'Cold'; payload: string };

function policyPayload(policyId: string, status: number, durationMs: number): string {
  return JSON.stringify({ policyId, http: { status }, durationMs });
}

const DOCS_CUSTOM_LOG_ROWS: readonly DocsCustomLogRow[] = [
  { message: 'Renewal quote created', rating: 'Cold', payload: policyPayload('POL-1042', 201, 318) },
  { message: 'Broker callback failed', rating: 'Hot', payload: policyPayload('POL-1043', 502, 4410) },
  { message: 'Premium lookup retried', rating: 'Warm', payload: policyPayload('POL-1044', 429, 1127) },
  { message: 'Invoice sync failed', rating: 'Hot', payload: policyPayload('POL-1045', 503, 3368) },
  { message: 'Cache refresh finished', rating: 'Cold', payload: 'Cache refresh finished without a payload' },
  { message: 'Renewal quote created', rating: 'Cold', payload: policyPayload('POL-1046', 201, 294) },
  { message: 'Premium mismatch escalated', rating: 'Hot', payload: policyPayload('POL-1047', 500, 3169) },
  { message: 'Underwriting callout timed out', rating: 'Hot', payload: policyPayload('POL-1048', 504, 5255) },
  { message: 'Slow broker callout', rating: 'Warm', payload: policyPayload('POL-1049', 200, 1548) },
  { message: 'Invoice sync failed', rating: 'Hot', payload: policyPayload('POL-1050', 503, 2126) },
  { message: 'Malformed broker response', rating: 'Warm', payload: '{"policyId":"POL-1051","http":' },
  { message: 'Payment declined', rating: 'Hot', payload: policyPayload('POL-1052', 502, 1127) },
  { message: 'Broker callback failed', rating: 'Hot', payload: policyPayload('POL-1053', 500, 4410) },
  { message: 'Renewal notice queued', rating: 'Cold', payload: policyPayload('POL-1054', 202, 87) },
  { message: 'Underwriting callout timed out', rating: 'Hot', payload: policyPayload('POL-1055', 504, 5064) },
  { message: 'Premium mismatch escalated', rating: 'Hot', payload: policyPayload('POL-1056', 500, 2986) }
];

export type DocsScenarioLogKey =
  | 'heroQuote'
  | 'heroHappyPath'
  | 'heroUnderwriting'
  | 'heroError'
  | 'heroBilling'
  | 'heroBroker'
  | 'heroNotice'
  | 'viewerRich'
  | 'tailLive';

export type DocsSeededLog = {
  key: DocsScenarioLogKey;
  marker: string;
  logId: string;
  filePath?: string;
};

export type PreparedDocsScenario = {
  searchQuery: string;
  logs: Record<Exclude<DocsScenarioLogKey, 'tailLive'>, DocsSeededLog>;
};

type DocsScenarioSeedSpec = {
  key: DocsScenarioLogKey;
  scenarioLabel: string;
  searchPhrase: string;
  extraDebugLines: string[];
  includeError: boolean;
};

type BuildDocsScenarioApexOptions = {
  marker: string;
  scenarioLabel: string;
  searchPhrase: string;
  extraDebugLines?: string[];
  includeError?: boolean;
};

const INITIAL_SCENARIO_SPECS: readonly DocsScenarioSeedSpec[] = [
  {
    key: 'heroQuote',
    scenarioLabel: 'Policy Renewal Quote',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: ['Policy renewal quote priced for the broker review'],
    includeError: false
  },
  {
    key: 'heroHappyPath',
    scenarioLabel: 'Policy Renewal Intake',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: [
      'Policy renewal candidate moved from triage to underwriting review',
      'Policy renewal intake completed without replay blockers'
    ],
    includeError: false
  },
  {
    key: 'heroUnderwriting',
    scenarioLabel: 'Policy Renewal Underwriting',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: ['Policy renewal underwriting checklist assigned to the case owner'],
    includeError: false
  },
  {
    key: 'heroError',
    scenarioLabel: 'Policy Renewal Escalation',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: [
      'Policy renewal premium mismatch escalated for broker approval',
      'Policy renewal exception path collected diagnostics for account owner'
    ],
    includeError: true
  },
  {
    key: 'heroBilling',
    scenarioLabel: 'Policy Renewal Billing',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: ['Policy renewal billing schedule rebuilt after the premium change'],
    includeError: false
  },
  {
    key: 'heroBroker',
    scenarioLabel: 'Policy Renewal Broker Sync',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: ['Policy renewal broker sync finished for the regional portfolio'],
    includeError: false
  },
  {
    key: 'heroNotice',
    scenarioLabel: 'Policy Renewal Notice',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: ['Policy renewal notice queued for the account owner'],
    includeError: false
  },
  {
    key: 'viewerRich',
    scenarioLabel: 'Policy Renewal Diagnostics',
    searchPhrase: DOCS_SEARCH_QUERY,
    extraDebugLines: [
      'Policy renewal premium mismatch surfaced before invoice finalization',
      'Policy renewal diagnostics captured database timing and DML checkpoints',
      'Policy renewal diagnostics finished with actionable triage context'
    ],
    includeError: true
  }
] as const;

const TAIL_SCENARIO_SPEC: DocsScenarioSeedSpec = {
  key: 'tailLive',
  scenarioLabel: 'Tail Live Renewal',
  searchPhrase: DOCS_TAIL_SEARCH_QUERY,
  extraDebugLines: ['Tail live renewal event reached the broker callback queue', DOCS_TAIL_ALERT_LINE],
  includeError: false
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeApexStringLiteral(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toDocsLogFileName(logId: string): string {
  return `docs_${logId}.log`;
}

async function fetchApexLogBody(targetOrg: string, auth: OrgAuth, logId: string): Promise<string> {
  const request = async (currentAuth: OrgAuth): Promise<Response> => {
    const url = `${currentAuth.instanceUrl.replace(/\/+$/, '')}/services/data/v${currentAuth.apiVersion}/tooling/sobjects/ApexLog/${logId}/Body`;
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${currentAuth.accessToken}`
      }
    });
  };

  let response = await request(auth);
  if (response.status === 401) {
    const refreshedAuth = await getOrgAuth(targetOrg, { forceRefresh: true });
    response = await request(refreshedAuth);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim();
    throw new Error(
      `Failed to download ApexLog body for ${logId} (${response.status})${detail ? `: ${detail}` : ''}`.trim()
    );
  }

  return await response.text();
}

async function waitForCreatedLogId(auth: OrgAuth, startedAtMs: number, marker: string): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const created = await findRecentApexLogId(auth, startedAtMs, marker);
    if (created) {
      return created;
    }
    await sleep(300);
  }
  throw new Error(`Failed to detect a newly created ApexLog for docs scenario marker "${marker}".`);
}

async function seedScenarioLog(
  targetOrg: string,
  auth: OrgAuth,
  spec: DocsScenarioSeedSpec,
  workspacePath?: string
): Promise<DocsSeededLog> {
  const marker = `ALV_DOCS_${spec.key.toUpperCase()}_${Date.now()}`;
  const startedAtMs = Date.now();
  await executeAnonymousApex(
    auth,
    buildDocsScenarioAnonymousApex({
      marker,
      scenarioLabel: spec.scenarioLabel,
      searchPhrase: spec.searchPhrase,
      extraDebugLines: spec.extraDebugLines,
      includeError: spec.includeError
    })
  );

  const logId = await waitForCreatedLogId(auth, startedAtMs, marker);
  let filePath: string | undefined;
  if (workspacePath) {
    const logsDir = path.join(workspacePath, 'apexlogs');
    await mkdir(logsDir, { recursive: true });
    filePath = path.join(logsDir, toDocsLogFileName(logId));
    await writeFile(filePath, await fetchApexLogBody(targetOrg, auth, logId), 'utf8');
  }

  return {
    key: spec.key,
    marker,
    logId,
    filePath
  };
}

export function getDocsScenarioSeedSpecs(): DocsScenarioSeedSpec[] {
  return INITIAL_SCENARIO_SPECS.map(spec => ({
    ...spec,
    extraDebugLines: [...spec.extraDebugLines]
  }));
}

export function getDocsTailScenarioSpec(): DocsScenarioSeedSpec {
  return {
    ...TAIL_SCENARIO_SPEC,
    extraDebugLines: [...TAIL_SCENARIO_SPEC.extraDebugLines]
  };
}

export function buildDocsScenarioAnonymousApex(options: BuildDocsScenarioApexOptions): string {
  const [snippetLine, ...extraDebugLines] = options.extraDebugLines ?? [];
  const lines = [
    // Salesforce logs each line of the script first, and a search shows the first match in the log as the row's snippet.
    ...(snippetLine ? [`System.debug('${escapeApexStringLiteral(snippetLine)}');`] : []),
    `String marker = '${escapeApexStringLiteral(options.marker)}';`,
    `String searchPhrase = '${escapeApexStringLiteral(options.searchPhrase)}';`,
    `String scenarioLabel = '${escapeApexStringLiteral(options.scenarioLabel)}';`,
    "System.debug(scenarioLabel + ' started');",
    "List<Case> existingCases = [SELECT Id, Subject, Status, Origin FROM Case WHERE Subject LIKE 'ALV Docs %' ORDER BY CreatedDate DESC LIMIT 5];",
    "System.debug('Renewal candidates: ' + existingCases.size());",
    'Case caseRecord = new Case(',
    "  Subject = 'ALV Docs ' + scenarioLabel + ' ' + marker.right(6),",
    "  Status = 'New',",
    "  Origin = 'Web',",
    "  Description = searchPhrase + ' generated by the Apex Log Viewer docs scenario'",
    ');',
    'insert caseRecord;',
    "caseRecord.Status = 'Working';",
    "caseRecord.Description = searchPhrase + ' in underwriting review, marker ' + marker;",
    'update caseRecord;',
    'Task followUpTask = new Task(',
    "  Subject = scenarioLabel + ' Follow Up',",
    "  Status = 'Not Started',",
    "  Priority = 'Normal',",
    '  WhatId = caseRecord.Id,',
    "  Description = searchPhrase + ' task created for the docs scenario'",
    ');',
    'insert followUpTask;',
    'List<Task> relatedTasks = [SELECT Id, Subject, Status, Priority FROM Task WHERE WhatId = :caseRecord.Id ORDER BY CreatedDate DESC LIMIT 5];',
    'for (Task relatedTask : relatedTasks) {',
    "  System.debug(relatedTask.Subject + ': ' + relatedTask.Status);",
    '}'
  ];

  for (const debugLine of extraDebugLines) {
    lines.push(`System.debug('${escapeApexStringLiteral(debugLine)}');`);
  }

  if (options.includeError) {
    lines.push(
      'try {',
      '  Object brokenContext = null;',
      '  System.debug(brokenContext.toString());',
      '} catch (Exception e) {',
      "  System.debug('Premium mismatch triage: ' + e.getMessage());",
      '}'
    );
  }

  lines.push("System.debug(scenarioLabel + ' finished');");
  return lines.join('\n');
}

export async function prepareDocsScreenshotScenario(options: {
  targetOrg: string;
  workspacePath: string;
}): Promise<PreparedDocsScenario> {
  return await timeE2eStep('docsScenario.prepare', async () => {
    const auth = await getOrgAuth(options.targetOrg);
    await ensureE2eTraceFlag(auth);

    const cleanupResult = await clearApexLogsForE2E(auth, 'all');
    if (cleanupResult.failed > 0) {
      throw new Error(`Failed to clear ${cleanupResult.failed} ApexLog(s) before preparing docs screenshots.`);
    }

    const seededLogs: DocsSeededLog[] = [];
    for (const spec of getDocsScenarioSeedSpecs()) {
      seededLogs.push(await seedScenarioLog(options.targetOrg, auth, spec, options.workspacePath));
    }

    const mapped = Object.fromEntries(seededLogs.map(log => [log.key, log])) as Record<
      Exclude<DocsScenarioLogKey, 'tailLive'>,
      DocsSeededLog
    >;

    return {
      searchQuery: DOCS_SEARCH_QUERY,
      logs: mapped
    };
  });
}

export async function emitDocsTailLog(targetOrg: string): Promise<DocsSeededLog> {
  return await timeE2eStep('docsScenario.tail', async () => {
    const auth = await getOrgAuth(targetOrg);
    await ensureE2eTraceFlag(auth);
    return await seedScenarioLog(targetOrg, auth, getDocsTailScenarioSpec());
  });
}

export async function clearDocsCustomLogs(auth: OrgAuth): Promise<void> {
  await executeAnonymousApex(auth, `delete [SELECT Id FROM Account WHERE TickerSymbol = '${DOCS_CUSTOM_LOG_TAG}'];`);
}

export async function seedDocsCustomLogs(auth: OrgAuth): Promise<void> {
  await timeE2eStep('docsScenario.customLogs', async () => {
    await clearDocsCustomLogs(auth);
    // One transaction per row, because the list sorts on CreatedDate and shows it as the row's time.
    for (const row of DOCS_CUSTOM_LOG_ROWS) {
      await executeAnonymousApex(
        auth,
        [
          'insert new Account(',
          `  Name = '${escapeApexStringLiteral(row.message)}',`,
          `  Rating = '${row.rating}',`,
          `  TickerSymbol = '${DOCS_CUSTOM_LOG_TAG}',`,
          `  Description = '${escapeApexStringLiteral(row.payload)}'`,
          ');'
        ].join('\n')
      );
    }
  });
}

export { toDocsLogFileName };
