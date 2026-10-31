// Shared by the events-* steps: the event source mapping, publishing through scripts/events-org.mjs (which refuses
// every org but alv-events) and the store location.
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SOURCE_ID = 'alv-events';
/** The event for scenarios that may replay `-2`: its retained backlog is only what the specs and steps published. */
export const DEFAULT_OBJECT = 'ALV_Test_Replay__e';

/** Writes the source into the session workspace's sfdx-project.json, the file a user edits. */
export async function mapEventSource(session, object) {
  const file = path.join(session.workspacePath, 'sfdx-project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.plugins = {
    electivus: {
      customLogs: {
        sources: [
          {
            id: SOURCE_ID,
            label: 'ALV events',
            event: {
              object,
              fields: {
                time: 'Logged_At__c',
                message: 'Message__c',
                level: 'Level__c',
                user: 'Username__c',
                transactionId: 'Transaction_Id__c',
                order: 'Sequence__c'
              }
            }
          }
        ]
      }
    }
  };
  await writeFile(file, JSON.stringify(project, null, 2), 'utf8');
}

/** Publishes `count` synthetic events to the events org and returns `{ runTag, transactionId, published }`. */
export async function publishEvents(session, { count, object, transactionId = 'verify' }) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(session.repoRoot, 'scripts', 'events-org.mjs'),
      'publish',
      '--count',
      String(count),
      '--transaction-id',
      transactionId,
      '--object',
      object
    ],
    { cwd: session.repoRoot, timeout: 5 * 60_000 }
  );
  const line = stdout
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith('{'))
    .at(-1);
  return JSON.parse(line);
}

/** `<workspace>/apexlogs/orgs/<org>/events/<object>`, once a capture created it. */
export async function eventsRoot(session, object) {
  const orgs = path.join(session.workspacePath, 'apexlogs', 'orgs');
  for (const org of await readdir(orgs)) {
    const candidate = path.join(orgs, org, 'events', object);
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // not this org
    }
  }
  throw new Error(`No event store for ${object} under ${orgs}`);
}

/** Stop answers at once, but the run still writes its last position; the lease file goes when the run is over. */
export async function waitForRunToEnd(root, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(path.join(root, 'capture.lease'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`The capture still holds ${root}/capture.lease after ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Opens the Custom Logs panel on the event source and tall enough to show rows. */
export async function openEventsPanel({ h, session, expect }, object) {
  await mapEventSource(session, object);
  await h.setWorkspaceSetting('electivus.apexLogViewer.customLogs.enabled', true);
  await h.runCommandWhenAvailable('Electivus Custom Logs: Focus on Electivus Custom Logs View');
  await h.runCommandWhenAvailable('Electivus Apex Logs: Refresh Custom Logs');
  await h.closeQuickInput();
  const logs = await h.customLogsFrame(180_000);
  const root = logs.getByTestId('custom-logs-root');
  const height = (await root.boundingBox())?.height ?? 0;
  if (height < 400) {
    // The bottom panel is about 260 px tall, which hides rows from a screenshot.
    await h.runCommand('View: Toggle Maximized Panel');
  }
  const strip = logs.getByTestId('custom-logs-capture');
  await expect(strip).toBeVisible({ timeout: 120_000 });
  return { logs, strip };
}
