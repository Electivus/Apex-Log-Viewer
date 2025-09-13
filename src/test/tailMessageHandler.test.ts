import assert from 'assert/strict';
import { TailMessageHandler } from '../provider/tailMessageHandler';

suite('TailMessageHandler', () => {
  test('ready posts init and loads orgs and debug levels', async () => {
    let orgs = 0;
    let levels = 0;
    const posts: any[] = [];
    const loading: boolean[] = [];
    const handler = new TailMessageHandler(
      async () => {
        orgs++;
      },
      async () => {
        levels++;
      },
      async () => {},
      async () => {},
      () => {},
      () => undefined,
      () => {},
      async () => {},
      () => {},
      () => {},
      () => false,
      () => 123,
      m => posts.push(m),
      v => loading.push(v)
    );
    await handler.handle({ type: 'ready' });
    assert.equal(orgs, 1, 'sendOrgs should be called');
    assert.equal(levels, 1, 'sendDebugLevels should be called');
    assert.deepEqual(loading, [true, false]);
    assert.ok(posts.find(m => m.type === 'init'), 'should post init');
    assert.ok(posts.find(m => m.type === 'tailConfig'), 'should post tailConfig');
    assert.ok(posts.find(m => m.type === 'tailStatus'), 'should post tailStatus');
  });

  test('selectOrg updates org and stops tail when changed', async () => {
    let selected: string | undefined = 'old';
    let stopped = 0;
    let setOrgArg: string | undefined;
    let orgs = 0;
    let levels = 0;
    const loading: boolean[] = [];
    const handler = new TailMessageHandler(
      async () => {
        orgs++;
      },
      async () => {
        levels++;
      },
      async () => {},
      async () => {},
      org => {
        selected = org;
      },
      () => selected,
      org => {
        setOrgArg = org;
      },
      async () => {},
      () => {
        stopped++;
      },
      () => {},
      () => false,
      () => 123,
      () => {},
      v => loading.push(v)
    );
    await handler.handle({ type: 'selectOrg', target: ' new ' });
    assert.equal(selected, 'new');
    assert.equal(setOrgArg, 'new');
    assert.equal(stopped, 1);
    assert.equal(orgs, 1);
    assert.equal(levels, 1);
    assert.deepEqual(loading, [true, false]);
  });

  test('tailStart starts tail with debug level', async () => {
    let started: string | undefined;
    const loading: boolean[] = [];
    const handler = new TailMessageHandler(
      async () => {},
      async () => {},
      async () => {},
      async () => {},
      () => {},
      () => undefined,
      () => {},
      async level => {
        started = level;
      },
      () => {},
      () => {},
      () => false,
      () => 123,
      () => {},
      v => loading.push(v)
    );
    await handler.handle({ type: 'tailStart', debugLevel: '  DL  ' });
    assert.equal(started, 'DL');
    assert.deepEqual(loading, [true, false]);
  });

  test('tailClear clears tail and posts reset', async () => {
    let cleared = 0;
    const posts: any[] = [];
    const handler = new TailMessageHandler(
      async () => {},
      async () => {},
      async () => {},
      async () => {},
      () => {},
      () => undefined,
      () => {},
      async () => {},
      () => {},
      () => {
        cleared++;
      },
      () => false,
      () => 123,
      m => posts.push(m),
      () => {}
    );
    await handler.handle({ type: 'tailClear' });
    assert.equal(cleared, 1);
    assert.ok(posts.find(m => m.type === 'tailReset'));
  });
});

