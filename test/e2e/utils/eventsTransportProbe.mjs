#!/usr/bin/env node
// Two probes against the events org that the `sf electivus` commands cannot reach on their own. Both print one
// JSON line per result and spend no event delivery (they subscribe at -1).
//
//   subscribe --alias <alv-events|alv-events-restricted> --object <event> [--from new|retained]
//       Opens core's own CometD transport once and prints `{ outcome: 'subscribed' }` or the typed failure Salesforce
//       caused. `capture` never gets this far for a user without Read on the event, because the describe fails first.
//   hold --alias alv-events --max N
//       Opens plain streaming clients until Salesforce refuses one, prints `{ held, refusal }`, and keeps them open
//       until stdin closes or the process is terminated. A capture started meanwhile meets the concurrent client limit.
//
// Run `pnpm run build:core` first: the transport comes from packages/core/lib.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ALIASES = ['alv-events', 'alv-events-restricted'];
const EVENT_OBJECTS = ['ALV_Test_Log__e', 'ALV_Test_Replay__e', 'ALV_Test_Backlog__e'];

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`bad argument ${name}`);
    flags[name.slice(2)] = argv[index + 1];
  }
  return flags;
}

async function connectionFor(alias) {
  if (!ALIASES.includes(alias)) throw new Error(`refused alias ${JSON.stringify(alias)}`);
  const { Org } = createRequire(path.join(REPO_ROOT, 'packages/core/package.json'))('@salesforce/core');
  const connection = (await Org.create({ aliasOrUsername: alias })).getConnection();
  connection.setApiVersion(await connection.retrieveMaxApiVersion());
  return connection;
}

const print = value => console.log(JSON.stringify(value));

async function subscribe(flags) {
  if (!EVENT_OBJECTS.includes(flags.object)) throw new Error(`refused object ${JSON.stringify(flags.object)}`);
  const from = flags.from ?? 'new';
  if (from !== 'new' && from !== 'retained') throw new Error('--from must be new or retained');
  const connection = await connectionFor(flags.alias);
  const { createCometdTransport } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/core/lib/customLogs/events/cometd.js')).href
  );
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let subscribedAfterMs;
  try {
    await createCometdTransport().open({
      connection,
      channel: `/event/${flags.object}`,
      from: { kind: from },
      durableCursor: () => undefined,
      signal: controller.signal,
      onSignal: signal => {
        if (signal.type !== 'subscribed' || subscribedAfterMs !== undefined) return;
        subscribedAfterMs = Date.now() - startedAt;
        controller.abort();
      }
    });
    print(
      subscribedAfterMs === undefined ? { outcome: 'timeout' } : { outcome: 'subscribed', afterMs: subscribedAfterMs }
    );
  } catch (error) {
    print({ outcome: 'failure', failure: error.failure ?? { kind: 'unexpected', message: String(error.message) } });
  } finally {
    clearTimeout(timer);
  }
}

async function hold(flags) {
  const max = Number(flags.max ?? 25);
  const connection = await connectionFor(flags.alias);
  const channel = '/event/ALV_Test_Log__e';
  const clients = [];
  let refusal;
  for (let index = 0; index < max && !refusal; index += 1) {
    const extension = {
      outgoing(message, callback) {
        if (message.channel === '/meta/subscribe') message.ext = { ...message.ext, replay: { [channel]: -1 } };
        callback(message);
      },
      incoming(message, callback) {
        if (message.successful === false && !refusal) {
          refusal = { channel: message.channel, error: message.error, failureReason: message.ext?.sfdc?.failureReason };
        }
        callback(message);
      }
    };
    const client = connection.streaming.createClient([extension]);
    clients.push(client);
    await new Promise(resolve => {
      const subscription = client.subscribe(channel, () => undefined);
      subscription.callback(resolve);
      subscription.errback(resolve);
      setTimeout(resolve, 10_000);
    });
  }
  print({ held: clients.length - (refusal ? 1 : 0), refusal: refusal ?? null });
  const release = () => {
    for (const client of clients) client.disconnect();
    setTimeout(() => process.exit(0), 2_000);
  };
  process.stdin.on('end', release);
  process.stdin.resume();
  process.once('SIGTERM', release);
}

const [command, ...rest] = process.argv.slice(2);
const handlers = { subscribe, hold };
if (!handlers[command]) {
  console.error('Usage: eventsTransportProbe.mjs <subscribe|hold> [--alias A] ...');
  process.exit(2);
}
try {
  await handlers[command](parseFlags(rest));
  if (command === 'subscribe') process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
