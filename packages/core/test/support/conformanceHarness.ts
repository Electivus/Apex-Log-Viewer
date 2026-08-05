import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

class ScriptedProcessDouble {
  readonly #remaining: ProcessInteraction[];

  public constructor(interactions: ProcessInteraction[]) {
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

function strictRemote(processDouble: ScriptedProcessDouble, httpDouble: ScriptedHttpDouble): ApexLogRemote {
  return {
    async resolveOrg(targetOrg) {
      processDouble.run({
        executable: 'sf',
        arguments: ['org', 'display', '--target-org', String(targetOrg || ''), '--json']
      });
      throw new Error('The initial corpus does not define remote org resolution.');
    },
    async listLogs(request) {
      httpDouble.request({ method: 'GET', url: `conformance://logs/${request.org.username}` });
      throw new Error('The initial corpus does not define remote log listing.');
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

async function executeScenario(scenario: ConformanceScenario, workspaceRoot: string): Promise<unknown> {
  const processDouble = new ScriptedProcessDouble(scenario.doubles.process);
  const httpDouble = new ScriptedHttpDouble(scenario.doubles.http);
  const core = createApexLogViewerCore({ apexLogRemote: strictRemote(processDouble, httpDouble) });
  const request = replaceWorkspaceToken(scenario.request, workspaceRoot) as JsonObject;

  try {
    let result: unknown;
    switch (scenario.operation) {
      case 'log.status':
        result = await core.log.status(request);
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
        await readWorkspace(workspaceRoot),
        scenario.workspace.after,
        `${scenario.id} workspace effects`
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}
