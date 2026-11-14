import { configureSalesforceProxy, createApexLogViewerCore } from '../../src/index.ts';

/**
 * Run as `node --import tsx salesforceProxyChild.ts <username> [settings-json]` with the proxy variables in its
 * environment from the start, as a CLI user sets them. It searches the users of the org `username` names, the way the
 * `sf electivus` plugin starts a core, and prints one JSON line. With `settings-json` it first applies proxy settings
 * the way the extension does.
 */
async function main(): Promise<void> {
  const [username, settings] = process.argv.slice(2);
  if (!username) {
    throw new Error('usage: salesforceProxyChild.ts <username> [settings-json]');
  }
  const core = createApexLogViewerCore();
  const configured = settings ? configureSalesforceProxy(JSON.parse(settings)) : undefined;
  try {
    const result = await core.user.search({ targetOrg: username, limit: 5 });
    console.log(JSON.stringify({ ok: true, users: result.users.length, configured }));
  } catch (error) {
    console.log(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), configured })
    );
  } finally {
    core.dispose();
  }
}

void main();
