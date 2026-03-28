import assert from 'assert/strict';
import {
  createDaemonProcess,
  type DaemonProcess,
} from '../../../../../packages/app-server-client-ts/src/index';
import { RuntimeClient } from '../../runtime/runtimeClient';

function makeLogsFixture(): string {
  return JSON.stringify({
    result: {
      records: [
        {
          Id: '07L000000000001AA',
          StartTime: '2026-03-27T12:00:00.000Z',
          Operation: 'ExecuteAnonymous',
          Application: 'Developer Console',
          DurationMilliseconds: 125,
          Status: 'Success',
          Request: 'REQ-1',
          LogLength: 4096,
          LogUser: { Name: 'Ada' },
        },
      ],
    },
  });
}

suite('integration: runtime client e2e', () => {
  let daemon: DaemonProcess | undefined;

  function createClient(): RuntimeClient {
    return new RuntimeClient({
      clientVersion: '0.1.0',
      createProcess(executable) {
        daemon = createDaemonProcess(executable);
        return daemon;
      },
    });
  }

  teardown(() => {
    daemon?.dispose();
    daemon = undefined;
    delete process.env.ALV_TEST_SF_LOG_LIST_JSON;
    delete process.env.ALV_TEST_LOGS_CANCEL_DELAY_MS;
  });

  test('initializes against the real daemon and reads fixture-backed logs', async () => {
    process.env.ALV_TEST_SF_LOG_LIST_JSON = makeLogsFixture();

    const client = createClient();
    const initialize = await client.initialize();
    const logs = await client.logsList({ limit: 1 });

    assert.equal(initialize.protocol_version, '1');
    assert.equal(initialize.capabilities.logs, true);
    assert.equal(logs[0]?.Id, '07L000000000001AA');
    assert.equal(logs[0]?.Operation, 'ExecuteAnonymous');
    assert.equal(logs[0]?.LogUser?.Name, 'Ada');
  });

  test('cancels an in-flight logs request and stays usable for the next request', async () => {
    process.env.ALV_TEST_SF_LOG_LIST_JSON = makeLogsFixture();
    process.env.ALV_TEST_LOGS_CANCEL_DELAY_MS = '400';

    const client = createClient();
    await client.initialize();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(
      client.logsList({ limit: 1 }, controller.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );

    const logs = await client.logsList({ limit: 1 });
    assert.equal(logs[0]?.Id, '07L000000000001AA');
  });
});
