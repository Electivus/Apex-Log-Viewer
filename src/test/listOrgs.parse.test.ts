import assert from 'assert/strict';
import { listOrgs, __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/cli';

suite('listOrgs parsing and sorting', () => {
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('merges groups and sorts with default first, then alias', async () => {
    let called = 0;
    __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
      called++;
      // Expect the first candidate: sf org list --json
      assert.equal(program, 'sf');
      assert.ok(args?.includes('org'));
      assert.ok(args?.includes('list'));
      const payload = {
        result: {
          orgs: [
            {
              username: 'b@example.com',
              alias: 'beta',
              isDefaultUsername: false,
              instanceUrl: 'https://b.my.salesforce.com'
            }
          ],
          nonScratchOrgs: [
            {
              username: 'a@example.com',
              alias: 'alpha',
              isDefaultUsername: true,
              instanceUrl: 'https://a.my.salesforce.com'
            }
          ],
          scratchOrgs: [
            {
              username: 'c@example.com',
              alias: 'charlie',
              isDefaultUsername: false,
              instanceUrl: 'https://c.my.salesforce.com'
            }
          ],
          sandboxes: [],
          devHubs: [],
          results: [
            { username: 'b@example.com', alias: 'beta' },
            { username: 'a@example.com', alias: 'alpha' },
            { username: 'c@example.com', alias: 'charlie' }
          ]
        }
      };
      cb(null, JSON.stringify(payload), '');
      return undefined as any;
    }) as any);

    const orgs = await listOrgs();
    assert.equal(called, 1, 'should resolve using first candidate');
    assert.equal(orgs.length, 3);
    // Default org first
    assert.equal(orgs[0]!.username, 'a@example.com');
    assert.equal(orgs[0]!.alias, 'alpha');
    assert.equal(orgs[0]!.isDefaultUsername, true);
    // Then alphabetical by alias/username
    assert.equal(orgs[1]!.alias, 'beta');
    assert.equal(orgs[2]!.alias, 'charlie');
  });
});
