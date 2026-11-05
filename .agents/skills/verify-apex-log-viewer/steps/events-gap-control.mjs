// Control for events-gap: requires the step to fail, for want of a gap of its own, when its Start resumes from the
// real position, so Salesforce rejects nothing. The buttons are wrapped so that the first Start after the step's
// Stop undoes the step's cursor edit before it clicks. The host caches events-gap.mjs, which this control imports,
// like steps/lib/: restart after editing it. Takes about 2 minutes and publishes one event when a gap is open.
// args: { object?: 'ALV_Test_Replay__e' }
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import eventsGap from './events-gap.mjs';
import { DEFAULT_OBJECT, eventsRoot } from './lib/events.mjs';

const OWN_GAP = 'this Start wrote a gap of its own';

const bound = (target, key) => {
  const value = Reflect.get(target, key);
  return typeof value === 'function' ? value.bind(target) : value;
};

const beforeClick = (locator, action) =>
  new Proxy(locator, {
    get(target, key) {
      if (key !== 'click') return bound(target, key);
      return async (...clickArgs) => {
        await action();
        return target.click(...clickArgs);
      };
    }
  });

export default async function (context) {
  const { h, session, args } = context;
  const object = args.object ?? DEFAULT_OBJECT;
  let stopped = false;
  let undone = 0;
  const undoCursorEdit = async () => {
    if (!stopped || undone > 0) return;
    const file = path.join(await eventsRoot(session, object), 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(file, 'utf8'));
    const [transport, replayId] = checkpoint.cursor.split(':');
    await writeFile(
      file,
      JSON.stringify({ ...checkpoint, cursor: `${transport}:${Number(replayId) - 1_000_000}` }, null, 2)
    );
    undone += 1;
  };
  const withUndoneStart = frame =>
    new Proxy(frame, {
      get(target, key) {
        if (key !== 'getByRole') return bound(target, key);
        return (role, options) => {
          const locator = target.getByRole(role, options);
          if (role !== 'button') return locator;
          if (options?.name === 'Stop') return beforeClick(locator, async () => (stopped = true));
          if (options?.name === 'Start') return beforeClick(locator, undoCursorEdit);
          return locator;
        };
      }
    });

  let failure;
  try {
    await eventsGap({
      ...context,
      h: { ...h, customLogsFrame: async (...frameArgs) => withUndoneStart(await h.customLogsFrame(...frameArgs)) }
    });
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    throw new Error(
      `events-gap passed although its Start resumed from the real position (${undone} cursor edit undone) and added no gap`
    );
  }
  if (undone !== 1 || !failure.message.includes(OWN_GAP)) {
    throw new Error(`events-gap failed for another reason (${undone} cursor edits undone): ${failure.message}`);
  }
  return { undone, failure: failure.message.split('\n')[0] };
}
