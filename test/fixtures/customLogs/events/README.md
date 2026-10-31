# Custom Logs event fixtures

Fixtures for the platform event source of Custom Logs. They come from the dedicated scratch org `alv-events`, which `scripts/events-org.mjs` creates and operates. Every event is synthetic: the script invents each payload and publishes it to `ALV_Test_Log__e`, an event that no trigger, flow or Apex subscribes to. The harness orgs are never involved.

| File                         | Content                                                                      | How it was made                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `describe-alv-test-log.json` | Trimmed describe of `ALV_Test_Log__e` (`queryable: false`, key prefix `e00`) | `node scripts/events-org.mjs verify --capture-describe`                                                                  |
| `burst-870.events.json`      | 870 messages as one CometD response (every `batch` is `0`)                   | `publish --count 870 --transaction-id events --run-tag bsn870 --level mixed`, then `record --name burst-870 --replay -2` |
| `single.events.json`         | The last of those events alone                                               | `record --name single --replay 1626054`, the replay id of event 869                                                      |

A recording is an array of `{ batch, data }`. `data` is what Faye hands to the subscription callback (`schema`, `payload`, `event`). `batch` numbers the HTTP responses the messages arrived in. `record` sanitizes before it writes: org ids, record ids and usernames outside the reserved example domains become stable placeholders, and `record` refuses to write a file in which `findLeaks` still finds any. Replay ids, event uuids and timestamps are kept, because tests depend on their order.

The published events are retained for 72 hours. To refresh a recording, publish again and record again.

## No `split-800-70`

The design lists a recording of the 800 + 70 split, taken from the Nebula harness org: 870 events, about 6.6 KB each, replayed from an id far below the oldest retained event, arrived as two responses 1.4 s and 1.7 s apart. It did not reproduce on `alv-events`:

- 870 events of about 0.7 KB (583 KB), replayed from `1624186` (the first replay id minus 1,000): one response. The recorded file was byte-identical to `burst-870`, so the same events record to the same file whatever the cursor.
- 60 events of 90,000 characters (5.4 MB), replayed after the previous event: one response.

Neither event count nor response size alone causes the split. The Nebula events were about 20 hours old, these were under one hour old. That is a guess, not a measurement. The Bayeux double slices `burst-870` at 800 and 70 and adds the 1.5 s delay itself, which tests the same adapter behavior.
