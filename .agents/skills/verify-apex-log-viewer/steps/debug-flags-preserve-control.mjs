#!/usr/bin/env node
import applyRemove from './debug-flags-apply-remove.mjs';
import { userDeveloperLogFlags } from './lib/traceFlags.mjs';

export default async function (context) {
  const { h, expect, session } = context;
  const flags = await userDeveloperLogFlags(h, session);
  const before = await flags.read();
  expect(before.length, 'The control requires a seeded current user').toBeGreaterThan(0);
  let refusal;
  try {
    await applyRemove({ ...context, args: { currentUser: true } });
  } catch (error) {
    refusal = error.message;
  }
  expect(refusal).toMatch(/Refusing.*existing DEVELOPER_LOG/);
  expect(await flags.read()).toEqual(before);

  const user = await h.tooling.ensureDebugFlagsTestUser(flags.auth);
  expect(user.id, 'A separate test user is required').not.toBe(flags.userId);
  expect(await h.tooling.getUserDebugTraceFlag(flags.auth, user.id)).toBeUndefined();
  let injected;
  try {
    await applyRemove({
      ...context,
      args: {},
      h: {
        ...h,
        shot: async () => {
          throw new Error('Control failure after Apply');
        }
      }
    });
  } catch (error) {
    injected = error.message;
  }
  expect(injected).toBe('Control failure after Apply');
  expect(await h.tooling.getUserDebugTraceFlag(flags.auth, user.id)).toBeUndefined();
  expect(await flags.read()).toEqual(before);
  return {
    refusedExistingFlags: true,
    failedApplyCleaned: true,
    preservedCurrentFlags: before.map(flag => flag.Id),
    shot: await h.shot('debug-flags-preserve-control')
  };
}
