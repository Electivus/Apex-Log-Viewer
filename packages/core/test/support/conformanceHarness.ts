import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';

import { AlvError, ApexLogLifecycleError, createApexLogViewerCore } from '../../src/index.ts';
import type { ApexLogRemote } from '../../src/logLifecycle.ts';

type JsonObject = Record<string, unknown>;

type WorkspaceFile = {
  path: string;
  content: string;
};

type ProcessInteraction = {
  id: string;
  request: { executable: string; arguments: string[]; cwd?: string };
  response: { exitCode: number; stdout: string; stderr: string };
};

type HttpInteraction = {
  id: string;
  request: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};

type ConformanceScenario = {
  schemaVersion: '1.0';
  id: string;
  description: string;
  operation: string;
  request: JsonObject;
  workspace: { before: WorkspaceFile[]; after: WorkspaceFile[] };
  doubles: { process: ProcessInteraction[]; http: HttpInteraction[] };
  expected: { result: unknown } | { failure: { code: string; message?: string } };
};

const workspaceToken = '<workspace>';
const corpusRoot = path.resolve(__dirname, '../../../../test/conformance/v1');

function replaceWorkspaceToken(value: unknown, workspaceRoot: string): unknown {
  if (Array.isArray(value)) return value.map(item => replaceWorkspaceToken(item, workspaceRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceWorkspaceToken(item, workspaceRoot)])
    );
  }
  if (typeof value === 'string') return value.replaceAll(workspaceToken, workspaceRoot);
  return value;
}

function normalizeWorkspacePaths(value: unknown, workspaceRoot: string): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeWorkspacePaths(item, workspaceRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeWorkspacePaths(item, workspaceRoot)])
    );
  }
  if (typeof value !== 'string') return value;
  const normalized = value.replaceAll('\\', '/');
  const normalizedRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/$/, '');
  return normalized === normalizedRoot
    ? workspaceToken
    : normalized.startsWith(`${normalizedRoot}/`)
      ? `${workspaceToken}${normalized.slice(normalizedRoot.length)}`
      : value;
}

function takeMatching<TInteraction extends { id: string; request: unknown }>(
  remaining: TInteraction[],
  request: unknown,
  boundary: string
): TInteraction {
  const index = remaining.findIndex(interaction => {
    try {
      assert.deepEqual(interaction.request, request);
      return true;
    } catch {
      return false;
    }
  });
  assert.notEqual(index, -1, `unexpected ${boundary} request: ${JSON.stringify(request)}`);
  return remaining.splice(index, 1)[0]!;
}

function assertUnambiguousRequests<TInteraction extends { id: string; request: unknown }>(
  interactions: TInteraction[],
  boundary: string
): void {
  for (const [index, interaction] of interactions.entries()) {
    const duplicate = interactions
      .slice(0, index)
      .find(candidate => isDeepStrictEqual(candidate.request, interaction.request));
    assert.equal(
      duplicate,
      undefined,
      `ambiguous ${boundary} request shared by interactions ${duplicate?.id} and ${interaction.id}`
    );
  }
}

class ScriptedProcessDouble {
  readonly #remaining: ProcessInteraction[];

  public constructor(interactions: ProcessInteraction[]) {
    assertUnambiguousRequests(interactions, 'process');
    this.#remaining = structuredClone(interactions);
  }

  public run(request: ProcessInteraction['request']): ProcessInteraction['response'] {
    return takeMatching(this.#remaining, request, 'process').response;
  }

  public assertSatisfied(): void {
    assert.deepEqual(
      this.#remaining.map(interaction => interaction.id),
      [],
      'unconsumed process interactions'
    );
  }
}

class ScriptedHttpDouble {
  readonly #remaining: HttpInteraction[];

  public constructor(interactions: HttpInteraction[]) {
    assertUnambiguousRequests(interactions, 'HTTP');
    this.#remaining = structuredClone(interactions);
  }

  public request(request: HttpInteraction['request']): HttpInteraction['response'] {
    return takeMatching(this.#remaining, request, 'HTTP').response;
  }

  public assertSatisfied(): void {
    assert.deepEqual(
      this.#remaining.map(interaction => interaction.id),
      [],
      'unconsumed HTTP interactions'
    );
  }
}

function strictRemote(
  processDouble: ScriptedProcessDouble,
  httpDouble: ScriptedHttpDouble,
  workspaceRoot: string
): ApexLogRemote {
  let connection: { username: string; instanceUrl: string; accessToken: string; apiVersion: string } | undefined;
  return {
    async resolveOrg(targetOrg) {
      const response = processDouble.run({
        executable: 'sf',
        arguments: ['org', 'display', '--target-org', String(targetOrg || ''), '--json'],
        cwd: workspaceRoot
      });
      assert.equal(response.exitCode, 0, `sf org display failed: ${response.stderr}`);
      const envelope = JSON.parse(response.stdout) as {
        status?: number;
        result?: Record<string, unknown>;
      };
      const result = envelope.result;
      assert.equal(envelope.status, 0, 'sf org display returned a failure envelope');
      assert.ok(result, 'sf org display omitted its result');
      connection = {
        username: String(result.username || ''),
        instanceUrl: String(result.instanceUrl || '').replace(/\/+$/, ''),
        accessToken: String(result.accessToken || ''),
        apiVersion: String(result.apiVersion || '63.0')
      };
      assert.ok(connection.username, 'sf org display omitted username');
      assert.ok(connection.instanceUrl, 'sf org display omitted instanceUrl');
      assert.ok(connection.accessToken, 'sf org display omitted accessToken');
      return { username: connection.username, instanceUrl: connection.instanceUrl };
    },
    async listLogs(request) {
      assert.ok(connection, 'log listing requires resolved connection material');
      assert.equal(request.org.username, connection.username);
      const soql =
        'SELECT Id, StartTime, Operation, Status, LogLength FROM ApexLog ' +
        `ORDER BY StartTime DESC, Id DESC LIMIT ${request.limit}`;
      const response = httpDouble.request({
        method: 'GET',
        url: `${connection.instanceUrl}/services/data/v${connection.apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
        headers: {
          Authorization: `Bearer ${connection.accessToken}`
        }
      });
      assert.ok(response.status >= 200 && response.status < 300, `Tooling request failed with ${response.status}`);
      const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
      const records = (body as { records?: Array<Record<string, unknown>> } | undefined)?.records ?? [];
      return records.map(record => ({
        logId: String(record.Id || ''),
        ...(record.StartTime === undefined ? {} : { startTime: String(record.StartTime) }),
        ...(record.Operation === undefined ? {} : { operation: String(record.Operation) }),
        ...(record.Status === undefined ? {} : { status: String(record.Status) }),
        ...(record.LogLength === undefined ? {} : { logLength: Number(record.LogLength) })
      }));
    },
    async readBody(request) {
      httpDouble.request({ method: 'GET', url: `conformance://logs/${request.logId}/body` });
      throw new Error('The initial corpus does not define remote log reads.');
    }
  };
}

async function writeWorkspace(root: string, files: WorkspaceFile[]): Promise<void> {
  for (const file of files) {
    const destination = path.resolve(root, file.path);
    const relative = path.relative(root, destination);
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      `unsafe workspace path: ${file.path}`
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content, 'utf8');
  }
}

async function readWorkspace(root: string, current = root): Promise<WorkspaceFile[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: WorkspaceFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await readWorkspace(root, absolutePath)));
    else if (entry.isFile()) {
      files.push({
        path: path.relative(root, absolutePath).replaceAll('\\', '/'),
        content: await fs.readFile(absolutePath, 'utf8')
      });
    }
  }
  return files;
}

function sortedWorkspace(files: WorkspaceFile[]): WorkspaceFile[] {
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function executeScenario(scenario: ConformanceScenario, workspaceRoot: string): Promise<unknown> {
  const doubles = replaceWorkspaceToken(scenario.doubles, workspaceRoot) as ConformanceScenario['doubles'];
  const processDouble = new ScriptedProcessDouble(doubles.process);
  const httpDouble = new ScriptedHttpDouble(doubles.http);
  const core = createApexLogViewerCore({ apexLogRemote: strictRemote(processDouble, httpDouble, workspaceRoot) });
  const request = replaceWorkspaceToken(scenario.request, workspaceRoot) as JsonObject;

  try {
    let result: unknown;
    switch (scenario.operation) {
      case 'log.status':
        result = await core.log.status(request);
        break;
      case 'log.list':
        result = await core.log.list(request);
        break;
      default:
        assert.fail(`unsupported TypeScript conformance operation: ${scenario.operation}`);
    }
    return {
      result: JSON.parse(JSON.stringify(normalizeWorkspacePaths(result, workspaceRoot)))
    };
  } catch (error) {
    const code =
      error instanceof AlvError || error instanceof ApexLogLifecycleError
        ? error.code
        : `UNCLASSIFIED_${error instanceof Error ? error.name : 'ERROR'}`;
    return {
      failure: {
        code,
        ...('failure' in scenario.expected && scenario.expected.failure.message && error instanceof Error
          ? { message: error.message }
          : {})
      }
    };
  } finally {
    core.dispose();
    processDouble.assertSatisfied();
    httpDouble.assertSatisfied();
  }
}

async function loadScenarios(): Promise<ConformanceScenario[]> {
  const schema = JSON.parse(await fs.readFile(path.join(corpusRoot, 'schemas', 'scenario.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const scenarioDirectory = path.join(corpusRoot, 'scenarios');
  const scenarioFiles = (await fs.readdir(scenarioDirectory)).filter(file => file.endsWith('.json')).sort();
  assert.ok(scenarioFiles.length > 0, 'the v1 conformance corpus must contain scenarios');

  return Promise.all(
    scenarioFiles.map(async file => {
      const scenario = JSON.parse(await fs.readFile(path.join(scenarioDirectory, file), 'utf8'));
      assert.equal(
        validate(scenario),
        true,
        `${file} does not match the v1 schema: ${JSON.stringify(validate.errors)}`
      );
      return scenario as ConformanceScenario;
    })
  );
}

export async function runTypeScriptConformance(): Promise<void> {
  for (const scenario of await loadScenarios()) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `alv-conformance-ts-${scenario.id}-`));
    try {
      await writeWorkspace(workspaceRoot, scenario.workspace.before);
      const outcome = await executeScenario(scenario, workspaceRoot);
      assert.deepEqual(outcome, scenario.expected, scenario.description);
      assert.deepEqual(
        sortedWorkspace(await readWorkspace(workspaceRoot)),
        sortedWorkspace(scenario.workspace.after),
        `${scenario.id} workspace effects`
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}
