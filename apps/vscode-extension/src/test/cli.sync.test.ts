import assert from 'assert/strict';
import { parseSyncOutput } from '../utils/cliClient';

suite('cliClient', () => {
  test('parseSyncOutput returns logs on ok payload', () => {
    const raw = JSON.stringify({
      ok: true,
      apiVersion: '64.0',
      limit: 2,
      savedDir: 'apexlogs',
      org: { username: 'user@example.com', instanceUrl: 'https://example.my.salesforce.com' },
      logs: [{ Id: '1' }, { Id: '2' }]
    });
    const parsed = parseSyncOutput(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.logs.length, 2);
    assert.ok(parsed.logs[0], 'expected first log entry');
    assert.equal(parsed.logs[0]?.Id, '1');
  });

  test('parseSyncOutput throws on error payload', () => {
    const raw = JSON.stringify({
      ok: false,
      errorCode: 'NO_SFDX_PROJECT',
      message: 'sfdx-project.json not found'
    });
    assert.throws(() => parseSyncOutput(raw), /NO_SFDX_PROJECT/);
  });
});
