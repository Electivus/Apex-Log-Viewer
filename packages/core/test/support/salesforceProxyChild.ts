import { configureSalesforceProxy, createApexLogViewerCore } from '../../src/index.ts';
import { authSourceDouble, loadSavedOrgs } from './salesforceDouble.ts';

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

type Search = {
  username: string;
  variables?: Record<string, string>;
  settings?: Parameters<typeof configureSalesforceProxy>[0];
};

async function search(core: ReturnType<typeof createApexLogViewerCore>, username: string) {
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  try {
    const result = await core.user.search({ targetOrg: username, limit: 5 });
    return { ok: true, users: result.users.length, elapsedMs: elapsedMs() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, elapsedMs: elapsedMs() };
  }
}

/** `--batch` reads searches from stdin and runs them one after another, each with its own variables and settings. */
async function batch(core: ReturnType<typeof createApexLogViewerCore>): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const results = [];
  for (const { username, variables = {}, settings = {} } of JSON.parse(input) as Search[]) {
    for (const name of PROXY_VARIABLES) delete process.env[name];
    Object.assign(process.env, variables);
    configureSalesforceProxy(settings);
    results.push(await search(core, username));
  }
  console.log(JSON.stringify(results));
}

async function main(): Promise<void> {
  const [username, settings] = process.argv.slice(2);
  if (!username) {
    throw new Error('usage: salesforceProxyChild.ts <username> [settings-json] | --batch');
  }
  if (process.env.ALV_TEST_PLATFORM)
    Object.defineProperty(process, 'platform', { value: process.env.ALV_TEST_PLATFORM });
  loadSavedOrgs();
  const core = createApexLogViewerCore({ auth: authSourceDouble() });
  try {
    if (username === '--batch') return await batch(core);
    if (settings) configureSalesforceProxy(JSON.parse(settings));
    console.log(JSON.stringify(await search(core, username)));
  } finally {
    core.dispose();
  }
}

void main();
