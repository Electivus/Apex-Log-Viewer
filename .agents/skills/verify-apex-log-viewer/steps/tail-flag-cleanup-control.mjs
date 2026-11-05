// Control for tail-live's trace-flag cleanup. The "Start created a flag" branch needs a user without a
// DEVELOPER_LOG flag, which on a harness scratch means deleting the seed (TraceFlag LogType and TracedEntityId are
// not updateable). So inject what Start does instead: move the seed to another level and create a flag the user
// did not have, then run the step's restore and require the flags to equal the snapshot again.
import { userDeveloperLogFlags } from './lib/traceFlags.mjs';

export default async function ({ h, expect, session }) {
  const flags = await userDeveloperLogFlags(h, session);
  const before = await flags.read();
  expect(before.length, 'the session user has a DEVELOPER_LOG flag to move').toBeGreaterThan(0);
  const seed = before.reduce((a, b) => (Date.parse(a.ExpirationDate) >= Date.parse(b.ExpirationDate) ? a : b));
  const [other] = await flags.query(`SELECT Id FROM DebugLevel WHERE Id != '${seed.DebugLevelId}' LIMIT 1`);
  expect(other, 'the org has a second debug level').toBeTruthy();

  const iso = ms => new Date(ms).toISOString();
  const now = Date.now();
  let outcome;
  let stepError;
  try {
    const moved = await flags.tooling('PATCH', `/${seed.Id}`, {
      DebugLevelId: other.Id,
      StartDate: iso(now),
      ExpirationDate: iso(now + 30 * 60_000)
    });
    expect(moved.ok, `move the seed flag: ${moved.body}`).toBe(true);
    // Salesforce rejects overlapping DEVELOPER_LOG flags on one user, so the created flag starts after both windows.
    const createdStart = Math.max(Date.parse(seed.ExpirationDate), now + 30 * 60_000) + 60_000;
    const created = await flags.tooling('POST', '', {
      TracedEntityId: flags.userId,
      LogType: 'DEVELOPER_LOG',
      DebugLevelId: seed.DebugLevelId,
      StartDate: iso(createdStart),
      ExpirationDate: iso(createdStart + 10 * 60_000)
    });
    expect(created.ok, `create the extra flag: ${created.body}`).toBe(true);
    const injected = await flags.read();
    outcome = await flags.restore(before);
    const after = await flags.read();
    expect(outcome.errors, 'restore errors').toEqual([]);
    expect(outcome.deleted, 'the created flag is deleted').toEqual([JSON.parse(created.body).id]);
    expect(after, 'flags after the restore equal the snapshot').toEqual(before);
    return {
      deleted: outcome.deleted,
      restored: outcome.restored,
      before: await h.saveEvidence('tail-flag-cleanup-before', before),
      injected: await h.saveEvidence('tail-flag-cleanup-injected', injected),
      after: await h.saveEvidence('tail-flag-cleanup-after', after)
    };
  } catch (error) {
    stepError = error;
    throw error;
  } finally {
    if (!outcome) {
      const rollback = await flags.restore(before).catch(error => ({ errors: [String(error.message)] }));
      if (rollback.errors.length) {
        // Report a failed rollback, which leaves the seed moved, next to the step's own failure.
        const message = `tail-flag-cleanup-control could not put the flags back: ${rollback.errors.join('; ')}`;
        if (stepError) {
          stepError.message += `\n${message}`;
          if (typeof stepError.stack === 'string') {
            stepError.stack += `\n${message}`;
          }
        } else {
          throw new Error(message);
        }
      }
    }
  }
}
