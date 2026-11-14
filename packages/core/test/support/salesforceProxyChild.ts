import { configureSalesforceProxy, createApexLogViewerCore } from '../../src/index.ts';

async function main(): Promise<void> {
  const [username, settings] = process.argv.slice(2);
  if (!username) {
    throw new Error('usage: salesforceProxyChild.ts <username> [settings-json]');
  }
  const core = createApexLogViewerCore();
  const configured = settings ? configureSalesforceProxy(JSON.parse(settings)) : undefined;
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  try {
    const result = await core.user.search({ targetOrg: username, limit: 5 });
    console.log(JSON.stringify({ ok: true, users: result.users.length, configured, elapsedMs: elapsedMs() }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ ok: false, error: message, configured, elapsedMs: elapsedMs() }));
  } finally {
    core.dispose();
  }
}

void main();
