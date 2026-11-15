import assert from 'node:assert/strict';
import test from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { PersistentAuthInfo } from '../src/orgAuth.ts';
import { ORG_ID, isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();

// PersistentAuthInfo reads private @salesforce/core 9.2 state: the aggregator's map of auth configs, each config's
// merge step and its map of stamped fields. When a piece has another shape, a save must still do what
// AuthInfo.save does: with the stamp clock 10 s behind the auth file, write the file and lose the change to #1449.

type Orgs = { configs: Map<string, { contents: object }> };

function trailStampClock(t: test.TestContext, ms: number): void {
  const own = Object.getOwnPropertyDescriptor(globalThis.performance, 'timeOrigin');
  const origin = performance.timeOrigin - ms;
  Object.defineProperty(globalThis.performance, 'timeOrigin', { get: () => origin, configurable: true });
  t.after(() => {
    if (own) Object.defineProperty(globalThis.performance, 'timeOrigin', own);
    else delete (globalThis.performance as { timeOrigin?: number }).timeOrigin;
  });
}

async function seeded(username: string): Promise<{ orgs: Orgs; ours: PersistentAuthInfo }> {
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: 'http://127.0.0.1:9',
    accessToken: 'token-0',
    refreshToken: 'refresh-token-0',
    clientId: 'PlatformCLI'
  });
  await state.orgs.write(username);
  const ours = await PersistentAuthInfo.create({ username });
  return { orgs: state.orgs as unknown as Orgs, ours };
}

async function persisted(username: string): Promise<{ accessToken?: string; refreshToken?: string }> {
  await StateAggregator.clearInstanceAsync();
  const fields = await (await StateAggregator.getInstance()).orgs.peek(username, true);
  return { accessToken: fields?.accessToken, refreshToken: fields?.refreshToken };
}

const unusableShapes: Record<string, (orgs: Orgs, username: string) => void> = {
  'stamped fields read as null': (orgs, username) => {
    Object.defineProperty(orgs.configs.get(username)?.contents, 'state', { get: () => null, configurable: true });
  },
  'stamped fields read as undefined': (orgs, username) => {
    Object.defineProperty(orgs.configs.get(username)?.contents, 'state', { get: () => undefined, configurable: true });
  },
  'stamped fields read as an array': (orgs, username) => {
    Object.defineProperty(orgs.configs.get(username)?.contents, 'state', { get: () => [], configurable: true });
  },
  'auth config cache cleared': orgs => {
    orgs.configs.clear();
  }
};

for (const [shape, inject] of Object.entries(unusableShapes)) {
  test(`a save with ${shape} saves as AuthInfo does`, async t => {
    const username = `private-${shape.replaceAll(' ', '-')}@example.com`;
    const { orgs, ours } = await seeded(username);
    inject(orgs, username);
    trailStampClock(t, 10_000);

    await ours.save({ accessToken: 'token-changed' });

    assert.deepEqual(await persisted(username), { accessToken: 'token-0', refreshToken: 'refresh-token-0' });
  });
}

const keptLifecycles: Record<string, (orgs: Orgs) => Promise<void>> = {
  'the auth config cache wrapped in an object that is not a Map': async orgs => {
    const configs = orgs.configs;
    (orgs as { configs: unknown }).configs = {
      get: configs.get.bind(configs),
      set: configs.set.bind(configs),
      has: configs.has.bind(configs),
      delete: configs.delete.bind(configs),
      keys: configs.keys.bind(configs),
      values: configs.values.bind(configs),
      entries: configs.entries.bind(configs),
      [Symbol.iterator]: configs[Symbol.iterator].bind(configs)
    };
  },
  'a second StateAggregator': async () => {
    await StateAggregator.create();
  },
  'the instance cleared with clearInstanceAsync': () => StateAggregator.clearInstanceAsync(),
  'the instance cleared with clearInstance': async () => {
    StateAggregator.clearInstance();
  }
};

for (const [lifecycle, happen] of Object.entries(keptLifecycles)) {
  test(`a save after ${lifecycle} keeps its change`, async t => {
    const username = `lifecycle-${lifecycle.replaceAll(' ', '-')}@example.com`;
    const { orgs, ours } = await seeded(username);
    await happen(orgs);
    trailStampClock(t, 10_000);

    await ours.save({ accessToken: 'token-changed' });

    assert.deepEqual(await persisted(username), { accessToken: 'token-changed', refreshToken: 'refresh-token-0' });
  });
}
