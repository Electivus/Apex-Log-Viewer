// Shared by the events-* steps: the event source mapping, publishing through scripts/events-org.mjs (which refuses
// every org but alv-events) and the store location.
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SOURCE_ID = 'alv-events';
/** scripts/events-org.mjs publishes only to this alias. */
const EVENTS_ORG_ALIAS = 'alv-events';
/** The event for scenarios that may replay `-2`: its retained backlog is only what the specs and steps published. */
export const DEFAULT_OBJECT = 'ALV_Test_Replay__e';

/** Writes the source into the session workspace's sfdx-project.json, the file a user edits. `mapping` is a full `event` object that replaces the default one. */
export async function mapEventSource(session, object, mapping) {
  const file = path.join(session.workspacePath, 'sfdx-project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.plugins = {
    electivus: {
      customLogs: {
        sources: [
          {
            id: SOURCE_ID,
            label: 'ALV events',
            event: mapping ?? {
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
export async function publishEvents(session, { count, object, transactionId = 'verify', payloadEntries }) {
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
      object,
      ...(payloadEntries === undefined ? [] : ['--payload-entries', String(payloadEntries)])
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

/** `<workspace>/apexlogs/orgs/<org>/events/<object in lower case>`, once a capture created it. */
export async function eventsRoot(session, object) {
  const orgs = path.join(session.workspacePath, 'apexlogs', 'orgs');
  for (const org of await readdir(orgs)) {
    const candidate = path.join(orgs, org, 'events', object.toLowerCase());
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // not this org
    }
  }
  throw new Error(`No event store for ${object} under ${orgs}`);
}

/** Whether a capture stored a position for `object` here. The panel then resumes instead of asking the first-use question. */
export async function hasStoredPosition(session, object) {
  try {
    await readFile(path.join(await eventsRoot(session, object), 'checkpoint.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** The store's gaps by id, folded from every writer's `gaps.<writer>.ndjson`; `before` is set once a close line names the gap. */
export async function readGaps(root) {
  const files = (await readdir(root)).filter(name => name.startsWith('gaps.') && name.endsWith('.ndjson'));
  const lines = (await Promise.all(files.map(name => readFile(path.join(root, name), 'utf8'))))
    .flatMap(text => text.split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const gaps = new Map(lines.filter(line => line.op === 'open').map(line => [line.id, { ...line }]));
  for (const line of lines.filter(line => line.op === 'close')) {
    if (gaps.has(line.id)) gaps.get(line.id).before = line.before;
  }
  return gaps;
}

export const openGaps = async root => [...(await readGaps(root)).values()].filter(gap => gap.before === undefined);

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
export async function openEventsPanel({ h, session, expect }, object, mapping) {
  if (session.org.alias !== EVENTS_ORG_ALIAS) {
    // Publishing always goes to alv-events, so on any other org the rows could never appear.
    throw new Error(
      `The events-* steps need a session started with --target-org ${EVENTS_ORG_ALIAS}; this one runs on ${session.org.alias}.`
    );
  }
  await mapEventSource(session, object, mapping);
  await h.setWorkspaceSetting('electivus.apexLogViewer.customLogs.enabled', true);
  await h.runCommandWhenAvailable('Custom Logs: Focus on Custom Logs View');
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
