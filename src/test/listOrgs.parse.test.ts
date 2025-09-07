import assert from 'assert/strict';
import {
  __parseOrgListForTests,
  __setExecFileImplForTests,
  __resetExecFileImplForTests,
  __resetListOrgsCacheForTests
} from '../salesforce/cli';

suite('listOrgs parsing and sorting', () => {
  setup(() => {
    // Ensure no leftover cache (persistent or in-memory) interferes with this test
    __resetListOrgsCacheForTests();
  });
  teardown(() => {
    __resetExecFileImplForTests();
  });

  test('merges groups and sorts with default first, then alias', async () => {
    let called = 0;
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
    const orgs = __parseOrgListForTests(JSON.stringify(payload));
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
