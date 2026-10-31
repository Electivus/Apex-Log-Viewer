# Custom Logs

Custom Logs reads application logs that a logging framework writes to Salesforce. The logs are records, such as the `Log__c` and `LogEntry__c` records of Nebula Logger, or platform events, such as its `LogEntryEvent__e`. It has two surfaces over one core:

- The **Custom Logs** panel in VS Code, in the bottom panel area next to Logs and Tail.
- The `sf electivus custom-log` commands of the Salesforce CLI plugin: `sources`, `list`, `get`, `entry`, and `capture`.

Both surfaces read the same mapping from `sfdx-project.json` and return the same data. Custom Logs writes nothing to Salesforce. It keeps no copy of custom-log records on disk. A platform event is the one exception, because Salesforce cannot query an event after it is delivered. Core stores each event it captures under `apexlogs/`. See [Event sources](#event-sources).

## Turn on Custom Logs

The Custom Logs panel in VS Code is experimental and off by default. While it is off, VS Code shows no **Electivus Custom Logs** tab and no Custom Logs commands, and the extension runs none of the Custom Logs code: no `sfdx-project.json` watcher, no Salesforce requests, and no telemetry.

To turn it on, set `electivus.apexLogViewer.customLogs.enabled` to `true` in the Settings editor or in `settings.json`:

```jsonc
{
  "electivus.apexLogViewer.customLogs.enabled": true
}
```

The **Electivus Custom Logs** tab appears in the panel area and the commands appear in the Command Palette. VS Code does not need a reload. Set the value back to `false` to hide the tab and the commands again. That also closes an open Custom Logs editor tab and its transaction viewers.

The setting controls only the VS Code panel. The `sf electivus custom-log` commands do not read it and work in every case, so you can use them before you turn the panel on.

## Sources

A source names the objects that hold the logs and says what each field means. Every source has one of three shapes:

- `transactions`: a header object with one record per transaction, and an entry object whose records point to their header. Nebula Logger has this shape. A list row is one header record.
- `entries`: one object with one record per log call. A list row is one entry record. Opening a row shows every entry that has the same transaction id. When the source maps no `transactionId`, or the record has no value, the transaction is that one entry.
- `events`: one platform event object with one event per log call. A list row is one event. Salesforce cannot query a platform event, so the rows come from the local event store that `capture` fills. See [Event sources](#event-sources).

### Built-in Nebula Logger sources

Nebula Logger needs no configuration. Custom Logs has one built-in record source and one built-in event source for each distribution:

| Source id               | Distribution                            | Objects                                    |
| ----------------------- | --------------------------------------- | ------------------------------------------ |
| `nebula`                | Unlocked package or source deploy       | `Log__c` and `LogEntry__c`                 |
| `nebula-managed`        | Managed package with namespace `Nebula` | `Nebula__Log__c` and `Nebula__LogEntry__c` |
| `nebula-events`         | Unlocked package or source deploy       | `LogEntryEvent__e`                         |
| `nebula-events-managed` | Managed package with namespace `Nebula` | `Nebula__LogEntryEvent__e`                 |

The two event sources read the platform event that Nebula Logger publishes for each log entry. Use them in an org where Nebula does not save the entries as records, so the event is the only copy. An org that saves the records can read the same logs through `nebula`. The panel and the commands never pick an event source for you. See [Which source a command reads](#which-source-a-command-reads).

Detection uses two Tooling API metadata queries. `EntityDefinition` confirms that the objects exist. `FieldDefinition` then checks that the entry object has the fields `Log__c`, `TransactionEntryNumber__c`, `LoggingLevelOrdinal__c`, and `EpochTimestamp__c`. For an event source, the check runs on the event and looks for `TransactionId__c` in place of `Log__c`. An unrelated object that is also named `Log__c` fails that check. `FieldDefinition` lists fields regardless of field-level security, so hiding one of those fields from a user does not hide Nebula Logger from that user.

An org with both distributions shows both sources of each kind. Result keys use the unprefixed field names on all of them. `extra.Status__c`, `entryColumns[].key`, and detail keys such as `StackTrace__c` are the same on an unlocked and a managed org.

The built-in sources map no JSON payload. To add one, [replace the built-in source](#replace-a-built-in-nebula-source). A platform event has no `Has*` presence checkbox, so `presentDetails` is empty for `nebula-events`.

### Source states

`sf electivus custom-log sources --json` returns every source with its `state`. The panel shows the same states.

| State                                     | Meaning                                                                                                   | What to do                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ready`                                   | The objects exist, the user can read them, and every required field is readable and has an accepted type. | Nothing.                                                                                       |
| `notInstalled`                            | Built-in sources only. The org has no objects for this distribution.                                      | Nothing. An org with one Nebula distribution shows the other one as `notInstalled`.            |
| `notInstalled` with `"hint": "collision"` | The org has a `Log__c` object, but it is not Nebula Logger.                                               | Map that object as a project source. The hint goes away when a project source maps the object. |
| `unavailable`                             | Custom Logs cannot read the source. `reason` and `message` say why.                                       | See the next table.                                                                            |

| `reason`               | Meaning                                                                                                                                                                                            | What to do                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `objectNotFound`       | Project sources only. A mapped object does not exist in this org.                                                                                                                                  | Check the object API name in the mapping and the target org.                                                    |
| `objectNotReadable`    | The object exists, but describe does not return it for this user. For an event source, `capture` fails here, before it subscribes.                                                                 | Give the user read access to the object, for example with a permission set that the logging framework provides. |
| `requiredFieldMissing` | A required field (`entry.fields.time`, `entry.fields.message`, `event.fields.time`, `event.fields.message`, `entry.parent`, or `transaction.fields.startTime`) is absent or hidden from this user. | Fix the field name, or give the user read access to the field.                                                  |
| `fieldTypeMismatch`    | A role, detail, flag, or payload names a field of a type that the key does not accept.                                                                                                             | Map a field of an accepted type. See [Roles](#roles).                                                           |
| `metadataQueryRefused` | Salesforce refused the `EntityDefinition` or `FieldDefinition` query for this user. Custom Logs does not try another method.                                                                       | Run as a user who has API access and can query those Tooling API objects.                                       |
| `notQueryable`         | A record mapping (`entry` or `transaction`) names an object that SOQL cannot read, such as a platform event. For a platform event, the message says to map it under `event` instead.               | Move the mapping to `event` for a platform event, or map an object that SOQL can read.                          |
| `notAnEvent`           | An `event` mapping names an object that is not a platform event. For a record object, the message says to map it under `entry` instead.                                                            | Fix the object name, or map a record object under `entry`.                                                      |

Each source in the `sources` result also has these fields:

| Field            | Meaning                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `origin`         | `builtin`, or `config` for a project source. A project source that replaces a built-in source is `config`.                                                                                                   |
| `shape`          | `transactions`, `entries`, or `events`.                                                                                                                                                                      |
| `namespace`      | `Nebula` for `nebula-managed` and `nebula-events-managed`. Absent otherwise.                                                                                                                                 |
| `objects`        | The object API names the source reads. For a `notInstalled` source, the names that detection looked for. An `events` source has one name, as `{ "event": "LogEntryEvent__e" }`.                              |
| `hiddenFields`   | Mapping paths that Custom Logs dropped because describe does not return the field for this user, or, for an event source, because the stored describe does not list it. See [Permissions](#permissions).     |
| `unmappedLevels` | Values of the level picklist that no level table maps. A level filter never matches them. See [Levels](#levels).                                                                                             |
| `capabilities`   | `levelFilter` says whether `--min-level` works, and `userFilter` whether `--user` works. `apexLogLink` says whether the listed object maps `requestId`, so that `get` can look for the Apex debug log.       |
| `payload`        | The mapped JSON payload field and its default columns, under `transaction`, `entry`, or both. An `events` source reports its payload under `entry`. An empty object when the source maps none.               |
| `store`          | `events` sources only. What the local event store covers: the state, the directory to search, the oldest and newest event, the gaps, and the retention. See [The local event store](#the-local-event-store). |

The result also has `projectFile` (the `sfdx-project.json` that was read), `issues` (see [Configuration issues](#configuration-issues)), and `defaultSourceId` when exactly one source that a command can pick without `--source` is ready. An event source never counts.

### Which source a command reads

- `list` and `get --transaction-id` read the source that `--source` names. Without `--source`, they read the only ready record source. When several record sources are ready, they fail with `CUSTOM_LOG_SOURCE_REQUIRED` instead of picking one. A script that omits `--source` therefore never starts to read another source after someone adds one to the project.
- The CLI never picks an event source without `--source`, because capturing it spends the org's daily event delivery allocation. In an org where `nebula` and `nebula-events` are both ready, `list` without `--source` still reads `nebula`. In a project whose only ready source is an event source, `list` without `--source` fails with `CUSTOM_LOG_NO_SOURCE`, and the message names the ready event sources.
- `get --log-id` and `entry` find the source from the 3-character key prefix of the record id. With `--source`, the id must belong to that source. Project sources come before built-in sources when two sources map the same object.
- An event id starts with `e-`, and it carries no key prefix. `get --log-id` and `entry --entry-id` need `--source` for an event id, and fail with `CUSTOM_LOG_SOURCE_REQUIRED` without it.
- `capture` always needs `--source`, and it accepts an event source only. A record source fails with `CUSTOM_LOG_NOT_EVENT_SOURCE`.

### When changes take effect

Every command and every panel refresh reads `sfdx-project.json` again, so a mapping edit applies to the next call. Core caches the detection and describe answers in memory for each user, including the answers that found nothing. The CLI starts every run with an empty cache. The extension keeps one cache while the extension host runs. If Salesforce rejects a query with `INVALID_FIELD` or `INVALID_TYPE` because the schema or the user's permissions changed, core drops that user's cache, resolves the sources again, and retries once. An event source reads the describe that `capture` stored, so `list`, `get`, and `entry` see a change to the event's fields or to the user's permissions only after the next capture refreshes it.

## Map a source in sfdx-project.json

Project sources live in `sfdx-project.json` under `plugins.electivus.customLogs.sources`. Salesforce reserves the `plugins` key for Salesforce CLI plugin settings, and its own schema and validator accept any content under that key. The CLI reads the `sfdx-project.json` of the project that contains the current directory. The extension reads the `sfdx-project.json` of the Salesforce project open in VS Code. Without a project, only the built-in sources apply.

The extension validates and completes this block in the editor with the schema `sfdx-project.electivus.schema.json`. On completion, the schema offers three source skeletons, one for each shape.

### Project keys

| Key                  | Required | Value                                                                                                                                                                                                                                  |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`            | No       | The list of project sources.                                                                                                                                                                                                           |
| `eventRetentionDays` | No       | A whole number from 1 to 365, default 30. How many days of captured events the local event store keeps. One value covers the project, because two sources over one event object share one stored history. See [Retention](#retention). |

### Source keys

| Key           | Required                   | Value                                                                                                                                                                                                                                            |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | Yes                        | Lower-case letters, digits, and hyphens, starting with a letter, 40 characters at most. `--source` takes it. A project source that reuses `nebula`, `nebula-managed`, `nebula-events`, or `nebula-events-managed` replaces that built-in source. |
| `label`       | No                         | Display name, 80 characters at most. The default is the `id`.                                                                                                                                                                                    |
| `transaction` | No                         | The header object. Its presence makes the source a `transactions` source.                                                                                                                                                                        |
| `entry`       | Yes, unless `event` is set | The entry object.                                                                                                                                                                                                                                |
| `event`       | No                         | The platform event. Its presence makes the source an `events` source. It cannot appear beside `entry` or `transaction`.                                                                                                                          |
| `levels`      | No                         | Raw level values mapped to canonical levels. See [Levels](#levels).                                                                                                                                                                              |

`transaction` keys:

| Key       | Required | Value                                                       |
| --------- | -------- | ----------------------------------------------------------- |
| `object`  | Yes      | The header object API name.                                 |
| `fields`  | Yes      | Header roles. See [Roles](#roles). `startTime` is required. |
| `columns` | No       | Display-only fields. See [Columns](#columns).               |
| `payload` | No       | A long text field that holds JSON. See [Payload](#payload). |

`entry` keys:

| Key                   | Required                | Value                                                                                                                                                               |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `object`              | Yes                     | The entry object API name.                                                                                                                                          |
| `parent`              | With `transaction` only | The lookup or master-detail field on the entry object that points to the header. A `parent` without a `transaction` is an error.                                    |
| `fields`              | Yes                     | Entry roles. See [Roles](#roles). `time` and `message` are required.                                                                                                |
| `columns`             | No                      | Display-only fields. See [Columns](#columns).                                                                                                                       |
| `details`             | No                      | Long fields that `entry` reads on demand. See [Details](#details).                                                                                                  |
| `payload`             | No                      | A long text field that holds JSON. See [Payload](#payload).                                                                                                         |
| `systemMessagePrefix` | No                      | 1 to 255 characters. An entry whose message starts with this text is the logger's own bookkeeping and has `system: true`. The panel hides those entries by default. |

`event` takes the keys of `entry` except `parent`, because an event is not linked to a header. `object` is the platform event API name and ends in `__e`. `fields` has the `entry` roles, and `time` and `message` are required. `columns`, `details`, `payload`, and `systemMessagePrefix` work as they do for `entry`.

### Field paths

A field path is a field API name, such as `Message__c`, or one relationship hop, such as `CreatedBy.Username`. Write the names as they are in the org. Custom Logs does not add a namespace prefix to a project source, so a field of a managed package keeps its prefix in the mapping, as in `Nebula__Message__c`.

Under `event`, a path is a plain field name. A platform event carries ids and no relationships, so the parser rejects `CreatedBy.Username` and says to map a field of the event itself, such as `LoggedByUsername__c`.

### Roles

Roles are the fields whose meaning Custom Logs knows. The types are describe types: `string` is Text, `textarea` is Text Area or Long Text Area, `double` and `int` are Number, `boolean` is Checkbox, and `reference` is Lookup or Master-Detail. In the tables, text types are `string`, `textarea`, `picklist`, `email`, `url`, `id`, and `reference`. Number types are `double` and `int`.

`transaction.fields`:

| Role              | Required | Types                      | Use                                                                                                                                                                                               |
| ----------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTime`       | Yes      | `datetime` or number types | The row time. A number is epoch milliseconds. A row with no value shows its `CreatedDate`. `--since` and `--until` use this field when describe marks it filterable, and `CreatedDate` otherwise. |
| `name`            | No       | Text types                 | The row title, for example `Log-000123`.                                                                                                                                                          |
| `user`            | No       | Text types                 | The row user, and the `--user` filter when describe marks the field filterable.                                                                                                                   |
| `transactionId`   | No       | Text types                 | `get --transaction-id`. The field must be filterable.                                                                                                                                             |
| `requestId`       | No       | Text types                 | The link to the Apex debug log of the same request.                                                                                                                                               |
| `entryCount`      | No       | Number types               | `counts.entries`.                                                                                                                                                                                 |
| `errorCount`      | No       | Number types               | `counts.errors`.                                                                                                                                                                                  |
| `warningCount`    | No       | Number types               | `counts.warnings`.                                                                                                                                                                                |
| `maxLevelOrdinal` | No       | Number types               | The row level and the level filter, on the Apex `LoggingLevel.ordinal()` scale, where `FINEST` is 2 and `ERROR` is 8. Without it, a level filter on headers runs through their entries.           |

`entry.fields`:

| Role               | Required | Types                      | Use                                                                                                                                                                                              |
| ------------------ | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `time`             | Yes      | `datetime` or number types | The entry time. A number is epoch milliseconds. For an `entries` source, `--since` and `--until` use this field when describe marks it filterable, and `CreatedDate` otherwise.                  |
| `message`          | Yes      | `string` or `textarea`     | The message. `get` returns its first 2,000 characters and sets `previewClipped` when it cut more. `entry` returns all of it. For an `entries` source, the row title is its first 255 characters. |
| `messageTruncated` | No       | `boolean`                  | Sets the entry's `messageTruncated` when the logging framework cut the message before it saved it.                                                                                               |
| `order`            | No       | Number types               | The order inside a transaction. Without a sortable `order`, entries are ordered by `time`, then by `CreatedDate`. Ties are ordered by `Id`.                                                      |
| `level`            | No       | `picklist` or `string`     | The raw level, normalized through the [level table](#levels).                                                                                                                                    |
| `levelOrdinal`     | No       | Number types               | The level as an Apex ordinal. A value from 2 to 8 wins over `level`.                                                                                                                             |
| `origin`           | No       | Text types                 | Where the code logged the entry, for example a class and method.                                                                                                                                 |
| `user`             | No       | Text types                 | The entry user, and the `--user` filter of an `entries` source when describe marks the field filterable.                                                                                         |
| `transactionId`    | No       | Text types                 | Groups the entries of an `entries` source into one transaction, and `get --transaction-id`. The field must be filterable, or `get` opens the entry alone.                                        |
| `requestId`        | No       | Text types                 | The link to the Apex debug log, for an `entries` source.                                                                                                                                         |
| `exceptionType`    | No       | Text types                 | The exception type, for example `System.MathException`.                                                                                                                                          |
| `recordId`         | No       | Text types                 | The id of the record that the entry is about.                                                                                                                                                    |

On entries, the level filter uses `levelOrdinal` when describe marks it filterable, and `level` otherwise. On headers, it uses a filterable `maxLevelOrdinal`, or else the level fields of their entries. When no field is usable, `capabilities.levelFilter` is `false` and `--min-level` fails with `CUSTOM_LOG_UNSUPPORTED_FILTER`.

### Columns

`columns` lists display-only fields. Each one becomes a column labelled from describe, and its value comes back in `extra`, keyed by the path as you wrote it. Any field type works except the compound types `address`, `location`, `base64`, `anyType`, and `complexvalue`. A text value in `extra`, a row title, and a text role in a row or an entry keep their first 255 characters (`CUSTOM_LOG_CELL_CHARS`). To read a long text field whole, map it as a detail or a payload.

### Details

`details` lists long fields that the list and `get` never read. `entry` reads them on demand and returns each one with its state. A detail is either a field path or an object:

```json
"details": [
  "Stack_Trace__c",
  { "field": "Http_Body__c", "presence": "Has_Http_Body__c", "truncated": "Http_Body_Truncated__c" }
]
```

| Key         | Required | Value                                                                                                        |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `field`     | Yes      | A `string` or `textarea` field.                                                                              |
| `presence`  | No       | A Checkbox that is true when `field` has content. `get` lists such details in each entry's `presentDetails`. |
| `truncated` | No       | A Checkbox that is true when the logging framework cut the value. `entry` returns it as `truncated`.         |

### Payload

`payload` names a `string` or `textarea` field that holds JSON. The `transaction` object and the `entry` object can each map one. Core decodes it and turns its keys into paths that the panel can show as columns and filters. See [JSON payloads](#json-payloads). A payload is either a field path or an object:

```json
"payload": "Payload__c"
```

```json
"payload": { "field": "Payload__c", "columns": ["orderId", "http.status"] }
```

`columns` lists the team's default payload columns. Each one is a JSON path of 1 to 255 characters, with `.` for nesting and `[n]` for array items. Columns that a user adds in the panel stay in the VS Code workspace state for that user. The extension never writes them to `sfdx-project.json`.

### Levels

Custom Logs has seven canonical levels, from lowest to highest: `FINEST`, `FINER`, `FINE`, `DEBUG`, `INFO`, `WARN`, and `ERROR`. Raw values map to them without configuration when they are one of these names, `WARNING` (to `WARN`), `FATAL` (to `ERROR`), or `TRACE` (to `FINEST`). Matching ignores case.

`levels` maps other raw values, and it overrides the defaults:

```json
"levels": { "Critical": "ERROR", "Notice": "INFO" }
```

A raw value that no table maps has no `level`, and a level filter never matches it. Entries keep the stored value in `rawLevel`. When the level field is a picklist, `sources` lists its values that no table maps in `unmappedLevels`. A platform event field cannot be a picklist, so `unmappedLevels` is empty for an event source. Map unusual values in `levels`.

### Configuration issues

The parser reads each source on its own. A source with an error is skipped, and the other sources and the built-in sources still load. If a skipped source reused a built-in id, the built-in source is used again. `sources --json` returns every issue in `issues`, and the panel lists them as **Configuration issues**.

| Code              | Severity | Meaning                                                                                             |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `invalidJson`     | Error    | `sfdx-project.json` is not valid JSON. No project source loads.                                     |
| `notAnObject`     | Error    | A value that must be an object is not one.                                                          |
| `missingRequired` | Error    | A required key is absent.                                                                           |
| `invalidValue`    | Error    | A value has the wrong form, for example an invalid API name or a `parent` without a `transaction`.  |
| `duplicateId`     | Error    | Another source in the file already uses this `id`. The later source is skipped.                     |
| `unknownKey`      | Warning  | Custom Logs does not know this key and ignores it. The key is a typo or comes from a newer version. |

Each issue has a `pointer` (a JSON pointer such as `/plugins/electivus/customLogs/sources/0/entry/fields/time`), a `code`, a `severity`, and a `message`. The editor schema gives the same verdict. It rejects the cases that the parser calls errors, and it accepts unknown keys.

## Examples

### A home-grown object with a JSON payload

This `entries` source reads a custom `App_Log__c` object with one record per log call:

```json
{
  "packageDirectories": [{ "path": "force-app", "default": true }],
  "sourceApiVersion": "65.0",
  "plugins": {
    "electivus": {
      "customLogs": {
        "sources": [
          {
            "id": "app-log",
            "label": "App Log",
            "entry": {
              "object": "App_Log__c",
              "fields": {
                "time": "CreatedDate",
                "message": "Message__c",
                "level": "Severity__c",
                "origin": "Source__c",
                "user": "CreatedBy.Username",
                "transactionId": "Transaction_Id__c",
                "requestId": "Request_Id__c"
              },
              "columns": ["Category__c"],
              "details": ["Stack_Trace__c", { "field": "Http_Body__c", "truncated": "Http_Body_Truncated__c" }],
              "payload": { "field": "Payload__c", "columns": ["orderId", "http.status"] }
            },
            "levels": { "Critical": "ERROR", "Notice": "INFO" }
          }
        ]
      }
    }
  }
}
```

A list of that source returns the decoded payload in each row:

```console
$ sf electivus custom-log list --source app-log --target-org my-org --min-level WARN --payload-fields orderId,http.status --limit 2 --json
{
  "status": 0,
  "result": {
    "source": { "id": "app-log", "label": "App Log", "shape": "entries" },
    "columns": [{ "key": "Category__c", "label": "Category" }],
    "rows": [
      {
        "id": "a0B000000000002AAA",
        "time": "2026-10-29T23:41:07.000Z",
        "title": "Order sync failed",
        "user": "integration@example.com",
        "level": "ERROR",
        "transactionId": "11111111-2222-4333-8444-555555555555",
        "extra": { "Category__c": "Orders" },
        "payload": {
          "state": "parsed",
          "values": { "orderId": "ORD-1042", "http.status": 502 },
          "droppedPaths": 0,
          "cutValues": []
        }
      },
      {
        "id": "a0B000000000001AAA",
        "time": "2026-10-29T23:40:58.000Z",
        "title": "Retrying order sync",
        "user": "integration@example.com",
        "level": "WARN",
        "transactionId": "11111111-2222-4333-8444-555555555555",
        "extra": { "Category__c": "Orders" },
        "payload": { "state": "text" }
      }
    ],
    "payloadFields": [
      { "path": "orderId", "types": ["string"], "rows": 1 },
      { "path": "http.status", "types": ["number"], "rows": 1 },
      { "path": "http.body", "types": ["string"], "rows": 1 }
    ],
    "nextCursor": null
  },
  "warnings": []
}
```

`--payload-fields` kept two paths in `values`, and `payloadFields` still lists every path on the page. The second row's payload is plain text, so it has no values.

### A platform event

This `events` source reads a custom `App_Log__e` platform event, and the project keeps 14 days of captured events:

```json
{
  "plugins": {
    "electivus": {
      "customLogs": {
        "eventRetentionDays": 14,
        "sources": [
          {
            "id": "app-events",
            "label": "App events",
            "event": {
              "object": "App_Log__e",
              "fields": {
                "time": "Logged_At__c",
                "message": "Message__c",
                "level": "Level__c",
                "user": "Username__c",
                "transactionId": "Transaction_Id__c",
                "order": "Sequence__c"
              },
              "columns": ["Request_Id__c"],
              "details": [{ "field": "Stack_Trace__c", "presence": "Has_Stack_Trace__c" }],
              "payload": { "field": "Payload__c", "columns": [] }
            }
          }
        ]
      }
    }
  }
}
```

Bring the store up to date, then read it:

```console
$ sf electivus custom-log capture --source app-events --target-org my-org --json
{
  "status": 0,
  "result": {
    "source": { "id": "app-events", "label": "App events", "shape": "events" },
    "outcome": "quiet",
    "delivered": 412,
    "stored": 412,
    "newGaps": [],
    "store": {
      "state": "captured",
      "eventsRoot": "/work/my-project/apexlogs/orgs/dev@example.com/events/app_log__e",
      "oldest": "2026-10-28T09:14:03.120Z",
      "newest": "2026-10-29T23:41:07.120Z",
      "lastCaptureAt": "2026-10-29T23:41:19.311Z",
      "sizeBytes": 2097152,
      "retentionDays": 14,
      "gaps": []
    }
  },
  "warnings": []
}
$ sf electivus custom-log list --source app-events --min-level ERROR --since 2026-10-29 --json
{
  "status": 0,
  "result": {
    "source": { "id": "app-events", "label": "App events", "shape": "events" },
    "columns": [{ "key": "Request_Id__c", "label": "Request Id" }],
    "rows": [
      {
        "id": "e-0mvu6sr74-0000000009-3f0c5a1e9b7d4c2e8a6f1b3d5c7e9a02",
        "time": "2026-10-29T23:41:07.000Z",
        "title": "Order sync failed",
        "user": "integration@example.com",
        "level": "ERROR",
        "transactionId": "11111111-2222-4333-8444-555555555555",
        "extra": { "Request_Id__c": "TID:0000000000000000" },
        "payload": { "state": "parsed", "values": { "orderId": "ORD-1042" }, "droppedPaths": 0, "cutValues": [] }
      }
    ],
    "payloadFields": [{ "path": "orderId", "types": ["string"], "rows": 1 }],
    "nextCursor": null,
    "store": {
      "state": "captured",
      "eventsRoot": "/work/my-project/apexlogs/orgs/dev@example.com/events/app_log__e",
      "oldest": "2026-10-28T09:14:03.120Z",
      "newest": "2026-10-29T23:41:07.120Z",
      "lastCaptureAt": "2026-10-29T23:41:19.311Z",
      "sizeBytes": 2097152,
      "retentionDays": 14,
      "gaps": []
    }
  },
  "warnings": []
}
```

The `list` call made no request to Salesforce. Pass the row `id` to `get --log-id` or `entry --entry-id`, with `--source app-events`.

### Replace a built-in Nebula source

The built-in Nebula sources map no payload. To read JSON that your code writes into `LogEntry__c.Message__c`, add a project source with the id `nebula`. It replaces the built-in source in this project, so `--source nebula` keeps working. Copy the whole built-in definition, because a project source does not merge with the built-in source:

```json
{
  "plugins": {
    "electivus": {
      "customLogs": {
        "sources": [
          {
            "id": "nebula",
            "label": "Nebula Logger",
            "transaction": {
              "object": "Log__c",
              "fields": {
                "startTime": "StartTime__c",
                "name": "Name",
                "user": "LoggedByUsername__c",
                "transactionId": "TransactionId__c",
                "requestId": "RequestId__c",
                "entryCount": "TotalLogEntries__c",
                "errorCount": "TotalERRORLogEntries__c",
                "warningCount": "TotalWARNLogEntries__c",
                "maxLevelOrdinal": "MaxLogEntryLoggingLevelOrdinal__c"
              },
              "columns": ["SystemMode__c", "TransactionScenarioName__c", "Status__c"]
            },
            "entry": {
              "object": "LogEntry__c",
              "parent": "Log__c",
              "fields": {
                "time": "EpochTimestamp__c",
                "order": "TransactionEntryNumber__c",
                "message": "Message__c",
                "messageTruncated": "MessageTruncated__c",
                "level": "LoggingLevel__c",
                "levelOrdinal": "LoggingLevelOrdinal__c",
                "origin": "OriginLocation__c",
                "exceptionType": "ExceptionType__c",
                "recordId": "RecordId__c"
              },
              "columns": ["OriginType__c"],
              "details": [
                "ExceptionMessage__c",
                { "field": "ExceptionStackTrace__c", "presence": "HasExceptionStackTrace__c" },
                { "field": "StackTrace__c", "presence": "HasStackTrace__c" },
                { "field": "RecordJson__c", "presence": "HasRecordJson__c", "truncated": "RecordJsonTruncated__c" },
                "HttpRequestEndpointAddress__c",
                {
                  "field": "HttpRequestBody__c",
                  "presence": "HasHttpRequestBody__c",
                  "truncated": "HttpRequestBodyTruncated__c"
                },
                {
                  "field": "HttpResponseBody__c",
                  "presence": "HasHttpResponseBody__c",
                  "truncated": "HttpResponseBodyTruncated__c"
                },
                {
                  "field": "RestRequestBody__c",
                  "presence": "HasRestRequestBody__c",
                  "truncated": "RestRequestBodyTruncated__c"
                },
                {
                  "field": "RestResponseBody__c",
                  "presence": "HasRestResponseBody__c",
                  "truncated": "RestResponseBodyTruncated__c"
                },
                { "field": "DatabaseResultJson__c", "presence": "HasDatabaseResultJson__c" },
                "Tags__c"
              ],
              "payload": { "field": "Message__c", "columns": [] },
              "systemMessagePrefix": "Nebula Logger - "
            }
          }
        ]
      }
    }
  }
}
```

The replaced source has `origin: "config"`. A project source never gets the namespace prefix, so to replace `nebula-managed`, use the id `nebula-managed` and write every custom name with its prefix: `Nebula__Log__c`, `Nebula__StartTime__c`, and so on. Its `extra` and detail keys then carry the prefix too.

## The Custom Logs panel

The panel lists the rows of one source, newest first. Its toolbar has these controls:

- The org picker. The **Source** list appears next to it when more than one source is ready. The panel opens an event source on its own only when no record source is ready, so that a project with one event source has something to show. Selecting an event source spends nothing by itself. A source with no stored position asks the first-use question and subscribes nothing until you answer. A source with a stored position resumes capture. See [Capture in the panel](#capture-in-the-panel).
- **Refresh** reloads the list.
- **Open in editor** opens the same list in an editor tab.
- **Configure** opens the Custom Logs mapping in `sfdx-project.json`.

When no source is ready, the panel says why, with the state of each source and the configuration issues. The filter bar takes conditions in the form `field operator value`, joined by `and`. See [Filters and sorts run over loaded rows](#filters-and-sorts-run-over-loaded-rows). **+ Field** adds a payload path as a column. Selecting a row shows its payload as a tree. Each value in the tree has **+ Column**, which adds its path as a column, and **= value**, which adds a filter on that value. **Load more** reads the next page.

Opening a row opens the transaction in an editor tab. The viewer shows the header, the entries in transaction order, a level filter, a long-field filter, and a search over the loaded entries. Logger system messages stay hidden until you turn on **Show logger system messages**. Selecting an entry lists its long fields with their states, and opening one shows it in a read-only editor document. **Open Apex log** opens the debug log of the same request when the link is `linked`.

An event source adds a capture strip above the table. See [Capture in the panel](#capture-in-the-panel).

## Event sources

A platform event is not a record. Salesforce delivers it to the clients that are subscribed at that moment, keeps it for about 72 hours, and cannot return it from a query. An `events` source therefore works in two steps. `capture` subscribes and writes every event it receives to a local store under `apexlogs/`. `list`, `get`, and `entry` then read that store, so they work offline and keep history for longer than the 72 hours.

Capture runs only while you ask for it, from the panel or from a `capture` command. Nothing captures in the background. Events that Salesforce delivers while nothing is capturing are lost once Salesforce stops keeping them. Custom Logs shows that loss as a [gap](#gaps) and does not recover it.

### The local event store

Core owns the store. The extension and the CLI read and write it only through core. It sits beside the Apex logs of the same org, so no Apex log command reads it:

```text
apexlogs/orgs/<safe-org>/events/
	format.json
	.gitignore
	<object>/
		describe.json
		checkpoint.json
		gaps.<writer>.ndjson
		capture.lease
		<YYYY-MM-DD>/<HH>.<writer>.ndjson
```

| Path                                | Content                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format.json`                       | `{"version":1}`. A store with another version fails with `CUSTOM_LOG_STORE_UNAVAILABLE`.                                                                                                                                                                                       |
| `.gitignore`                        | `*`. The store ignores itself, so it never depends on the `.gitignore` of the project.                                                                                                                                                                                         |
| `<object>/`                         | One directory for each event object, named by its API name in lower case, such as `app_log__e`, or `nebula__logentryevent__e` for the built-in managed source. Two sources over one object share the directory, the history, and the subscription, whatever casing they write. |
| `describe.json`                     | The describe of the event for the user who captured it. Capture writes it before the first event and refreshes it on every run. Reads use it.                                                                                                                                  |
| `checkpoint.json`                   | The stored position: the org id, the replay cursor, the newest event, the time until which capture proved the store complete, and the time of the last write.                                                                                                                  |
| `gaps.<writer>.ndjson`              | The gaps, one file for each capture run.                                                                                                                                                                                                                                       |
| `capture.lease`                     | The owner of the subscription. See [Standby and the capture lease](#standby-and-the-capture-lease).                                                                                                                                                                            |
| `<YYYY-MM-DD>/<HH>.<writer>.ndjson` | The events, one JSON object per line, in the day and hour (UTC) of their `CreatedDate`. A capture run writes its own files and never rewrites a file.                                                                                                                          |

The store lives in the directory that holds `sfdx-project.json`, so a command run from a subdirectory uses the same store. When core finds no `sfdx-project.json`, it uses the directory the command runs in, or the folder that is open in VS Code. With neither, `capture` and `list` fail with `CUSTOM_LOG_STORE_UNAVAILABLE`.

Each line holds the whole event as Salesforce delivered it: `id`, `uuid`, `seq`, `replayId`, `createdDate`, `receivedAt`, and a `payload` with every field of the message except the null ones. The `id` is the row id, which `entry --entry-id` accepts, so a search hit leads straight to the event. The `replayId` is for search only, and no result or id exposes it. Core writes the events to disk before it moves the stored position, so a crash of the process delivers an event again and never loses it. A power loss on macOS can still lose the last flush.

The store keeps every delivered field. Salesforce applies no field-level security to platform event fields, so the subscriber receives every value. Reads still follow the stored describe. A mapped field that the describe does not list shows as `hidden`, for example when someone removed the field from the event after the capture. A permission never causes it. Core never decodes the value of a `hidden` field. The value stays on disk, so a later remap can use it and a search can find it.

Salesforce can deliver an event twice. Before it writes an event, core looks its `uuid` up among the events already stored in the hour of its `CreatedDate`, so a duplicate delivery, a crash replay and a replay of the whole 72 hours write each event once, however many events the window holds. Core reads the stored events of an hour only when an event of that hour arrives. If a copy still reaches disk, because a capture lost its lease before it noticed or because the copies carry different `CreatedDate` hours, the store keeps both and reads one row for each `uuid`.

### Retention

`eventRetentionDays` sets how long the store keeps events. It takes a whole number from 1 to 365, and the default is 30. When a capture run starts, core deletes the day directories older than that, and the gap files whose gaps all closed before the oldest kept day. Reads never delete. Nothing caps the size of the store, and `store.sizeBytes` reports it.

### Search the store

The store is plain text, so ripgrep and `jq` search the whole history. The `store.eventsRoot` of an event source, in `sources`, `list`, `get`, and `capture`, names the directory to search:

```bash
rg --no-ignore -g '*.ndjson' 'Order sync failed' "$(sf electivus custom-log sources --target-org my-org --json | jq -r '.result.sources[] | select(.id == "app-events") | .store.eventsRoot')"
```

Pass `--no-ignore`, because the store ignores itself and ripgrep honors `events/.gitignore`. A plain `rg` finds nothing. Each line is JSON, so a message with quotes, backslashes, or line breaks appears in its escaped form. Pass the `id` of a hit to `custom-log entry --entry-id` with `--source` to read the decoded event.

To bring the store up to date before a search, run `capture`. A search sees only what was captured.

### Read captured events

`list`, `get`, and `entry` read the store and make no request to the org. They resolve the username of the target org from the local Salesforce CLI authorization.

- `list` returns one row for each event, newest first in publish order: `CreatedDate`, then the delivery order inside one publish, then the `uuid`. A Nebula transaction publishes its entries together, so they share one `CreatedDate`, and the mapped time column can look out of order.
- `--since` and `--until` bound the `CreatedDate` of the event. `--min-level` and `--user` run over the stored rows. They need a mapped `level` or `levelOrdinal`, or a mapped `user`, and fail with `CUSTOM_LOG_UNSUPPORTED_FILTER` otherwise.
- `get --log-id` returns the event as `log` and its transaction in `entries`: the stored events with the same `transactionId` that are within one hour of it, in the order of the mapped `order`, then by position. An event with no `transactionId` value stands alone. `get --transaction-id` starts from the newest stored event with that value, which scans the store.
- `get` looks for the Apex debug log of the request through the org. When the lookup fails, for example because the machine has no connection to the org, `apexLog` is `unavailable` with `reason: "offline"`, and the rest of the result is unaffected.
- `entry` returns the full message, every mapped detail with its state, and the raw payload of one stored event.
- A source that was never captured answers `list` with an empty page and `store.state: "notCaptured"`. It is not an error. `get` and `entry` answer `CUSTOM_LOG_RECORD_NOT_FOUND`, and the message says to run `capture`.
- A cursor from an event source belongs to the org of the stored position, the source, the mapping, and the filters. A record cursor does not work on an event source, and an event cursor does not work on a record source. Both fail with `CUSTOM_LOG_INVALID_CURSOR`.

### Capture in the panel

Pick an event source in the **Source** list. The table shows the stored history at once, newest first, and a strip above the table shows the capture state.

- **A source with a stored position resumes by itself.** Opening it, or opening the panel again, starts capture from the stored position. The strip shows **Catching up** and then **Live**.
- **A source with no stored position asks once.** The strip says that no events from this org are stored, and nothing subscribes. **Load retained events** replays what Salesforce still keeps, up to 72 hours. **Only new events** starts with the events published from now on. The strip shows how many deliveries of the org's daily allocation remain and how many this run may use. After your choice, opening the source resumes by itself. A session that receives no event stores no position, so the strip asks again next time.
- **A run has a delivery budget.** It may use about half of what remains of the org's daily allocation, or 5,000 deliveries when Salesforce does not report the allowance. The check runs between flushes, and Salesforce hands over a whole response at a time, so a run can pass the budget by one response. A run that reaches it stores what it has and stops. **Start** resumes from the stored position.
- **Stop and Start.** **Stop** ends capture for the selected org and source. It stays stopped until you press **Start** or pick another org or source. **Start** runs capture again.
- **What keeps and what stops capture.** Refresh, a change of `since`, and hiding the panel keep capture running. A change of org or source, or of the level or user filter, restarts it. Closing the Custom Logs view or its editor tab stops the capture that surface started, and so does turning off `electivus.apexLogViewer.customLogs.enabled`. The view and the editor tab watch one capture run, and so do two sources over one event object. The run ends when its last watcher leaves.

The level and user filters change only which live rows the table shows. Capture stores every event. New rows appear in event-time order, and the table keeps the row you are looking at in place. Past 5,000 live rows, the panel reloads the newest page.

The strip shows one of these states:

| State                          | Strip                                                                                                                                                               | Buttons                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Connecting                     | `Connecting to <source>…`                                                                                                                                           | **Stop**                                      |
| Standby                        | `Another <VS Code window or sf command> (pid <pid> on <host>) is capturing; new events appear here.` and the lease note.                                            | **Stop**                                      |
| Catching up from the position  | `Catching up: loading events Salesforce kept since <time>`                                                                                                          | **Stop**                                      |
| Catching up on retained events | `Loading retained events (up to 72 hours)…`                                                                                                                         | **Stop**                                      |
| Catching up on new events      | `Waiting for new events…`                                                                                                                                           | **Stop**                                      |
| Live                           | `Live · stored since <time> · <size>`, with a tooltip that says the state is inferred.                                                                              | **Stop**                                      |
| Reconnecting                   | `Reconnecting (attempt <n>) after the connection dropped`, `after Salesforce rejected the session`, or `after a burst of events…`                                   | **Stop**                                      |
| Stopped                        | `Stopped · stored since <time> · <size>`. It shows after `quiet`, `timeLimit`, and `aborted`.                                                                       | **Start**                                     |
| Budget spent                   | `Paused: this run spent its delivery budget (about <n> deliveries of the org's daily allocation).`                                                                  | **Start**                                     |
| Captured elsewhere             | `Another VS Code window or sf command is capturing these events. Start to check again.` and the lease note.                                                         | **Start**                                     |
| First use                      | `No events from this org are stored yet.` with the allowance and the budget.                                                                                        | **Load retained events**, **Only new events** |
| Failed                         | `Capture failed: <message>`. For `CUSTOM_LOG_DELIVERY_LIMIT`, `Salesforce's daily event delivery limit is used up; capture resumes from the stored position later.` | **Start**                                     |

**Live** means that the stream was quiet for 10 seconds after events arrived, or that the first-event wait ended. Salesforce sends no end-of-backlog marker, so the strip cannot say that the backlog is complete.

Below the status, the strip lists one line for each gap in the store. See [Gaps](#gaps).

### Capture with the CLI

```bash
sf electivus custom-log capture --source app-events --target-org my-org --json
sf electivus custom-log capture --source app-events --target-org my-org --follow --min-level WARN
```

| Flag                      | Value                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source`                | Required. The id of an event source. Core never chooses one, because capturing spends the org's delivery allocation.                                                 |
| `--target-org`            | The org to capture from.                                                                                                                                             |
| `--follow`                | Keep capturing and print each stored row until you press Ctrl-C.                                                                                                     |
| `--max-time`              | Seconds, from 1 to 3,600. The default is 120. Stop after this long, even while events keep arriving. It cannot combine with `--follow`.                              |
| `--initial retained\|new` | For an org that this project never captured. `retained`, the default, replays the events Salesforce still keeps. `new` starts with the events published from now on. |
| `--min-level`, `--user`   | Need `--follow`. Print only the rows at or above the level, or logged by the user. The store keeps every event either way.                                           |

By default `capture` drains. It resumes from the stored position and stops when the first of these happens:

| `outcome`           | The run stopped because                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `quiet`             | The stream went quiet: 10 seconds without an event after events arrived, or the first-event wait ended with no event.                           |
| `timeLimit`         | `--max-time` passed while events were still arriving, or before the connection was up.                                                          |
| `budget`            | The run used its delivery budget. Run the command again to continue from the stored position.                                                   |
| `aborted`           | You pressed Ctrl-C with `--follow`.                                                                                                             |
| `capturedElsewhere` | Another process holds the capture lease. See [Standby and the capture lease](#standby-and-the-capture-lease).                                   |
| `needsInitial`      | The store has no stored position and the caller chose to start nothing. The panel uses it for the first-use question. The CLI never returns it. |

The result is the JSON shown in [A platform event](#a-platform-event). `delivered` is the number of events Salesforce delivered to the run, duplicates included, which is the allocation the run spent. `stored` counts the new events the run wrote, without re-deliveries of events the store already held. `newGaps` lists the gaps the run created. An open gap found at the start is not repeated there, and `store.gaps` lists every gap.

A drain waits for the first event before it can call the stream quiet. After a new start, or over a stored position that is younger than one hour, it waits 15 seconds. After a first run with `--initial retained`, or over a position older than one hour, it waits the whole `--max-time` (120 seconds by default), because the first event of a large backlog can take that long. A drain that hears nothing in that time still ends `quiet`. Lower `--max-time` for a stream that you know is quiet. A drain over a young position with `--max-time` under 15 seconds ends `timeLimit`, not `quiet`.

`quiet` does not prove that the backlog was complete. An early stop costs one more run, because the stored position is exact and the next run resumes after it. If that run starts when the oldest event the early stop left behind is more than 72 hours old, Salesforce may have expired it, and the run records a `retentionElapsed` gap.

With `--follow`, `capture` keeps running. It prints each stored row to stdout as `<time> <level> <user> <title>`, with `-` for a missing level or user. It prints state changes and the allowance to stderr. Ctrl-C ends the run with `Delivered <n>, stored <m>. Store: <eventsRoot>` and a line for each gap the run created, and exits with code 0. A second Ctrl-C quits at once with exit code 130. A closed stdout, as in `| head -1`, ends the run like Ctrl-C. With `--json`, `--follow` prints nothing until the run ends and then prints the result. SIGTERM and SIGHUP exit with code 130 and no summary. The stored position and the lease reclaim cover that case.

Every finished outcome exits with code 0, including `budget` and `capturedElsewhere`. A failure exits with code 1 and carries its code in `code` and `name`. `actions` lists what to try next, except for `INVALID_ARGUMENT`. See [Error codes](#error-codes).

### Gaps

A gap is an interval for which the store cannot vouch. Salesforce never says whether anything was published in the interval, so every gap means that events may be missing. The panel, `sources`, `list`, `get`, and `capture` report the gaps of the store.

| `reason`           | Capture records it when                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursorRejected`   | Salesforce rejected the stored position when capture resumed, because it is older than Salesforce keeps or comes from before a stream reset. Capture writes the gap, then replays what Salesforce still retains.                                                                  |
| `retentionElapsed` | The store covers nothing in the 72 hours before this run: its newest event, and the last time a capture proved that it had reached the newest event, are both older. Salesforce can accept such a position and still skip expired events, so an accepted position proves nothing. |
| `orgChanged`       | The username now names another org, for example after a sandbox refresh. Capture treats the store as having no position. The panel asks the first-use question again.                                                                                                             |
| `malformedEvent`   | Salesforce delivered a message that capture could not read as an event, so it stored nothing for it. The gap spans the events delivered around it, and the delivery still counts in `delivered`.                                                                                  |

A gap has the `reason`, `after` (the newest event stored before it), `before` (the first event stored after it), and `detectedAt`. `before` is absent while the gap is open. A gap closes at the first stored event newer than `after`. When a replay returns nothing newer, the gap stays open, and the strip says `Events after <time> may be missing`.

A replay after a rejected position can deliver events the store already holds. The store writes each event once. `stored` counts only the events that were new to the store, and `delivered` counts every delivery, so it shows what the replay cost. A second rejected position in one run ends the run with `CUSTOM_LOG_CAPTURE_FAILED`.

A quiet stream that you capture at least every 72 hours raises no `retentionElapsed` gap. A capture proves that it reached the newest event when it starts with **Only new events**, or when nothing arrives for 15 seconds after it subscribes. While it stays connected after that, it covers every event published until 5 minutes before it ends. A run that stores events and then stops, for its budget, its time limit, a **Stop** or a quiet pause in a replay, covers only up to its newest stored event, because a replay can pause for almost a minute between responses. A run that starts with a backlog and then hears nothing more never proves that it reached the newest event, so a capture more than 72 hours after its newest event shows a gap that may be empty.

### Standby and the capture lease

One process captures each event object at a time, so the org sees one subscription and delivers each event once. The process that holds `capture.lease` captures. The file names the holder: the surface (`vscode` or `cli`), the pid, the host, and the start time.

A panel or a `--follow` run that finds the lease held stands by. It shows the stored rows, names the holder, and shows the rows that the holder stores. It checks the lease every 2 seconds. At the first check after the holder's process on the same host ends, it takes the lease and connects. In one measurement against a real org, 3.2 seconds passed between the end of the holder and the resumed capture. A drain that finds the lease held stops with `capturedElsewhere`.

Core never takes a lease from a process that is still alive, from a process on another host, or from a lease it cannot read. An unreadable lease fails with `CUSTOM_LOG_STORE_UNAVAILABLE` and names the file. When the holder is gone and the lease stays, delete `capture.lease`. The hostname of a Mac can change between networks, so a dead local holder can then look like a process on another host. The strip says so in its lease note.

### Event source limits

- Salesforce keeps platform events for about 72 hours. Capture cannot read an event after that.
- Every delivered event counts against the daily delivery allocation of the whole org, together with every other subscriber. The size depends on the edition. A large replay can use up the day. Salesforce then stops delivering, capture ends with `CUSTOM_LOG_DELIVERY_LIMIT`, and the next run resumes from the stored position once the rolling 24-hour usage drops. A `retentionElapsed` gap marks the events that expired meanwhile.
- The org limits concurrent streaming clients. Past the limit, Salesforce refuses the handshake and capture fails with `CUSTOM_LOG_CLIENT_LIMIT`.
- `quiet` and **Live** do not prove that the backlog was complete.
- Loss outside a capture is shown as a gap and is not recovered.

## JSON payloads

Core decodes each mapped payload field once, so the panel, the transaction viewer, and the CLI see the same values. Each row or entry with a mapped payload has a `payload` with one of these states:

| State     | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `parsed`  | The value is a JSON object or array. `values` holds its scalar leaves. |
| `invalid` | The value starts with `{` or `[` but is not valid JSON.                |
| `text`    | The value is plain text, or a JSON scalar such as `42`.                |
| `empty`   | The field has no value.                                                |
| `hidden`  | The describe omits the field, for example under field-level security.  |

A row without a mapped payload has no `payload` key. JSON columns and payload filters skip rows that are not `parsed`, and the panel counts each state in its status bar.

### Paths

Core flattens a parsed payload into paths, in document order:

- Object keys join with `.`: `{"http": {"status": 502}}` becomes `http.status`.
- Array items get an index: `{"lines": [{"sku": "A1"}]}` becomes `lines[0].sku`, and a payload that is an array starts with one: `[{"status": 500}]` becomes `[0].status`.
- Only scalar leaves become paths: strings, numbers, booleans, and `null`. Empty objects and empty arrays add no path.
- Core does not escape a key that contains `.` or `[`, so such a key can give a path that reads two ways.

### Limits

Each row keeps at most 200 paths and at most 500 characters per string value:

- `droppedPaths` counts the scalar leaves past the first 200. `values` does not include them.
- `cutValues` lists the paths whose string value core cut at 500 characters.

To read the whole payload, use **Open full payload** in the panel, or the CLI. `entry` returns the entry's full payload as `rawPayload`, and `get` returns a header's full payload as `logPayload`. Both are long values with a `state` of `value`, `empty`, `hidden`, or `unmapped`. A `value` also has `format`, which is `json` when the text parses as a JSON object or array and `text` otherwise.

### Payload fields

Each `list` and `get` page returns `payloadFields`, which lists every path seen in that page's payloads with the JSON `types` found at the path and the number of `rows` that have it. Core computes it before `--payload-fields` trims `values`, so it always describes whole payloads. The panel merges `payloadFields` across the pages it has loaded, and offers those paths in its **+ Field** picker and its filter input.

### Filters and sorts run over loaded rows

SOQL cannot filter or sort long text fields, so core never filters on a payload path in Salesforce. In the panel, payload filters, payload sorts, and JSON columns work on the rows already loaded. Filter chips show where they run:

- Chips for `level`, `user`, `since`, and `source` show **Salesforce**. They change the query and reload the list. `level` takes `>=`, and the others take `=`.
- Chips for payload paths narrow the loaded rows. Number paths take `=`, `!=`, `>`, `>=`, `<`, `<=`, and `exists`. String paths take `=`, `!=`, `contains`, and `exists`. Boolean paths take `=`, `!=`, and `exists`.

The panel groups array indexes as `[]`, so `[].status >= 500` matches a row when any item has a status of at least 500, and `[0].status` reads the first item only. Quote a path that contains a space, a quote, or one of `<`, `>`, `=` and `!`, as in `"Account Name" = Acme`. A quoted field always names a payload path, so `"user" = alice` filters a payload key named `user`, and `user = alice` stays the Salesforce user filter. The suggestions of the filter input, the **Filter by this field** item of a column menu, and **= value** write the quotes for you.

Conditions combine with `and` only. The status bar reads "Filtering N loaded rows · M match". Use **Load more** to bring more rows into the filter.

In the CLI, `--payload-fields` keeps only the paths you name in each row's `values`. Filter with `jq`:

```bash
sf electivus custom-log list --source app-log --target-org my-org --limit 200 --json \
	| jq -r '.result.rows[] | select(.payload.state == "parsed" and .payload.values["http.status"] >= 500) | .id'
```

## Permissions

Custom Logs builds every query from describe, which returns only the fields that the running user can read. A query therefore never names a field that field-level security hides, and Salesforce never rejects it with `INVALID_FIELD` for that reason.

- A hidden required field makes the source `unavailable` with `requiredFieldMissing`.
- A hidden optional role, column, or flag is dropped from every query and listed in `hiddenFields`.
- A hidden detail or payload field stays in the result with `state: "hidden"`, so the panel can say that your permissions hide it. It is also listed in `hiddenFields`.

A platform event field has no field-level security. For an event source, `hidden` and `hiddenFields` mean that a mapped field is missing from the stored describe, for example because the field was removed from the event after the capture.

The paths in `hiddenFields` name the mapping key: `entry.fields.exceptionType`, `entry.columns.Category__c`, `entry.details.StackTrace__c`, `entry.details.RecordJson__c.truncated`, `entry.payload`, or the same forms under `transaction`.

In an unlocked Nebula Logger org, a user with only the `LoggerEndUser` permission set gets this `sources` result, shown here with three of its keys:

```json
{
  "id": "nebula",
  "state": "ready",
  "hiddenFields": [
    "entry.fields.exceptionType",
    "entry.details.ExceptionStackTrace__c",
    "entry.details.StackTrace__c",
    "entry.details.HttpRequestEndpointAddress__c",
    "entry.details.HttpRequestBody__c",
    "entry.details.HttpRequestBody__c.truncated",
    "entry.details.HttpResponseBody__c",
    "entry.details.HttpResponseBody__c.truncated",
    "entry.details.RestRequestBody__c",
    "entry.details.RestRequestBody__c.truncated",
    "entry.details.RestResponseBody__c",
    "entry.details.RestResponseBody__c.truncated",
    "entry.details.DatabaseResultJson__c",
    "entry.details.Tags__c"
  ]
}
```

That user can still read the `Has*` checkboxes. An entry's `presentDetails` can therefore list `StackTrace__c` while `entry` returns that detail as `hidden`. The entry has a stack trace, and this user cannot read it.

Custom Logs also needs these permissions:

- Access to the Tooling API queries on `EntityDefinition` and `FieldDefinition`. Without it, sources are `unavailable` with `metadataQueryRefused`.
- Read access to the log records through sharing. A record that the user cannot see is not listed, and `get` or `entry` on its id fails with `CUSTOM_LOG_RECORD_NOT_FOUND`.
- Read access to `ApexLog` through the Tooling API, for the debug log link. Without it, `apexLog` is `unavailable`.
- For an event source, Read access to the platform event object, because `capture` subscribes as that user. Without it, describe does not return the object. The source is `unavailable` with `objectNotReadable`, and `capture` fails with `CUSTOM_LOG_SOURCE_UNAVAILABLE` before it subscribes. `CUSTOM_LOG_SUBSCRIBE_FORBIDDEN` covers a subscription that Salesforce refuses after describe succeeded. Field-level security does not apply to platform event fields. See [The local event store](#the-local-event-store).

## Link to the Apex debug log

`get` looks for the Apex debug log of the same request. It matches `ApexLog.RequestIdentifier` with the row's `requestId`, which for Nebula Logger is `Log__c.RequestId__c`. The result is in `apexLog`:

| `state`       | Meaning                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linked`      | `logId` is the `ApexLog` id. `startTime` and `logLength` are present when Salesforce returns them.                                                                                                                                                  |
| `notFound`    | The user can read `ApexLog`, and none matches. No trace flag was active, or Salesforce already deleted the log.                                                                                                                                     |
| `unavailable` | `reason` is `noAccess`. The user cannot read `ApexLog` in this org, so the absence says nothing about the request. For an event source, `reason` is `offline` when the lookup failed, for example because the machine has no connection to the org. |
| `noRequestId` | The source maps no `requestId`, the field is hidden, or this record has no value.                                                                                                                                                                   |

In the panel, the transaction viewer's **Open Apex log** button opens the linked log. In a terminal, read it with the existing log commands:

```bash
sf electivus log read --log-id 07L000000000001AAA --target-org my-org
```

## Commands

| Command                           | Flags                                                                                                                                                          | Returns                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sf electivus custom-log sources` | `--target-org`                                                                                                                                                 | Every source with its state, `defaultSourceId`, `projectFile`, and `issues`.                                                                                          |
| `sf electivus custom-log list`    | `--target-org`, `--source`, `--limit` (1 to 200, default 50), `--cursor`, `--min-level`, `--user`, `--since`, `--until`, `--payload-fields`                    | One page of rows, newest first, with `columns`, `payloadFields`, and `nextCursor`.                                                                                    |
| `sf electivus custom-log get`     | `--target-org`, `--log-id` or `--transaction-id` (exactly one), `--source`, `--limit` (1 to 2,000, default 200), `--cursor`, `--min-level`, `--payload-fields` | The `log` row, one page of `entries` in transaction order, `entryColumns`, `payloadFields`, `nextCursor`, `apexLog`, and `logPayload` when the header maps a payload. |
| `sf electivus custom-log entry`   | `--target-org`, `--entry-id`, `--source`                                                                                                                       | The full `entry`, its `logId`, every mapped detail in `details`, and `rawPayload`.                                                                                    |
| `sf electivus custom-log capture` | `--source` (required), `--target-org`, `--follow`, `--max-time`, `--initial`, `--min-level`, `--user`                                                          | One `CustomLogCaptureResult`: `source`, `outcome`, `delivered`, `stored`, `newGaps`, and `store`. See [Capture with the CLI](#capture-with-the-cli).                  |

The commands have no project flag. They read the `sfdx-project.json` of the project that contains the current directory, as `sf project deploy` does.

- `--min-level` keeps rows at or above a level. A transaction counts at its highest level. Values are `FINEST`, `FINER`, `FINE`, `DEBUG`, `INFO`, `WARN`, and `ERROR`.
- `--user` takes an exact username. The match ignores case.
- `--since` keeps rows at or after a time, and `--until` keeps rows before a time. Each takes a duration before now (a positive whole number followed by `m`, `h`, or `d`, such as `30m`, `24h`, or `7d`) or an ISO-8601 instant with an offset, such as `2026-10-29T12:00:00Z`. A bare date such as `2026-10-29` means midnight UTC.
- `--payload-fields` takes paths separated by commas, and you can repeat it. Paths match exactly.
- `--transaction-id` takes the framework's own transaction id, such as Nebula's `TransactionId__c`. For an `entries` source, `get` then pages every entry with that transaction id.
- `get --log-id` takes a list row `id`. For an `entries` source, any entry id of the transaction works.

List rows are ordered by `CreatedDate`, newest first, then by `Id`, because `CreatedDate` always has a value. A row shows its mapped time, so two rows logged seconds apart can appear out of order by that time. An `entries` source lists every entry as its own row. An `events` source lists every stored event as its own row, ordered by publish order: `CreatedDate`, then the delivery order inside one publish, then the event `uuid`. `list`, `get`, and `entry` on an event source read the local store and need a `--source`. See [Read captured events](#read-captured-events).

Paging is by cursor. When `nextCursor` is not `null`, pass it back with `--cursor` and the same filter flags to read the next page. `--limit` can change between pages. A cursor is bound to the org, the source, the source's mapping, the kind of page, and the filters. A list cursor also carries the time window that `--since` resolved on the first page, so `--since 24h` does not move between pages.

`get` returns at most the first 2,000 characters of each message. `entry` returns the full message, every mapped detail with its state (`value`, `empty`, or `hidden`), and the raw payload. Entries with `system: true` are the logging framework's own bookkeeping, such as Nebula Logger's messages that start with `Nebula Logger - `.

With `--json`, a failed command exits with a non-zero status, and the JSON output has the error code in `code`.

## Error codes

| Code                               | Cause                                                                                                                                                                                                                                                                                     | What to do                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CUSTOM_LOG_NO_SOURCE`             | No source can be picked without `--source`: none is ready, or the only ready sources are event sources. In the second case the message names the ready event sources.                                                                                                                     | Run `sf electivus custom-log sources` and fix the state that each source reports, or pass `--source` with an event source.                                                                                            |
| `CUSTOM_LOG_SOURCE_REQUIRED`       | Several sources are ready, and the command named none. The message lists their ids. Also returned when `get --log-id` or `entry` receives an event id without `--source`.                                                                                                                 | Pass `--source`.                                                                                                                                                                                                      |
| `CUSTOM_LOG_SOURCE_NOT_FOUND`      | `--source` names an unknown id, no ready source owns the record id's key prefix, or the id does not belong to the `--source` source.                                                                                                                                                      | Check the id with `sources`, and check that the record id comes from this org.                                                                                                                                        |
| `CUSTOM_LOG_SOURCE_UNAVAILABLE`    | `--source` names a source that is `notInstalled` or `unavailable`. The message gives the reason. For an event source, a user without Read access to the event fails here with `objectNotReadable`, before any subscription.                                                               | Fix the cause that `sources` reports, or pick a ready source.                                                                                                                                                         |
| `CUSTOM_LOG_RECORD_NOT_FOUND`      | The record or transaction id does not exist, or this user cannot read it. Also returned when `get --log-id` receives an entry id of a `transactions` source, or `entry` receives a header id. For an event source, the event is not in the local store, or the source was never captured. | Check the id. For a `transactions` source, pass the header id to `get`, which `entry` returns as `logId`. For an event source, run `capture` and try again.                                                           |
| `CUSTOM_LOG_AMBIGUOUS_TRANSACTION` | Several headers have the requested transaction id. The message lists their ids.                                                                                                                                                                                                           | Pass one of them with `--log-id`.                                                                                                                                                                                     |
| `CUSTOM_LOG_UNSUPPORTED_FILTER`    | The source lacks a role that the filter needs. `--min-level` needs a level mapping, `--user` needs a `user` role, and a transaction id lookup needs a filterable `transactionId` role.                                                                                                    | Remove the filter, or map the missing role in `sfdx-project.json`.                                                                                                                                                    |
| `CUSTOM_LOG_INVALID_CURSOR`        | The cursor is malformed, or it comes from another org, another source, an older mapping, another kind of page, other filters, or the other kind of source (record or event).                                                                                                              | Run the command again without `--cursor`.                                                                                                                                                                             |
| `CUSTOM_LOG_STORE_UNAVAILABLE`     | The event store cannot be used. Core found no folder to keep it in, the store has a newer `format.json`, a lease or a checkpoint cannot be read, a store directory is a symbolic link, or a write failed. The message names the file or directory.                                        | Run the command inside a Salesforce project, at or below the directory that holds `sfdx-project.json`. Then fix the file that the message names. After a failed write, the next run resumes from the stored position. |
| `CUSTOM_LOG_NOT_EVENT_SOURCE`      | `capture` named a record source.                                                                                                                                                                                                                                                          | Pick a source whose `shape` is `events`, or read a record source with `list`.                                                                                                                                         |
| `CUSTOM_LOG_DELIVERY_LIMIT`        | Salesforce stopped delivering because the org used its daily platform event delivery allocation (`403::Organization total events daily limit exceeded`, the text that Salesforce documents).                                                                                              | Run `capture` again later. It resumes from the stored position once the rolling 24-hour usage drops.                                                                                                                  |
| `CUSTOM_LOG_CLIENT_LIMIT`          | Salesforce refused the handshake because the org has too many concurrent streaming clients (`403::Handshake denied`, with the failure reason `403::Organization concurrent user limit exceeded`).                                                                                         | Close other subscribers, then run `capture` again.                                                                                                                                                                    |
| `CUSTOM_LOG_SUBSCRIBE_FORBIDDEN`   | Salesforce refused the subscription (`403:denied_by_security_policy:create_denied`, or `403::Restricted channel`, which Salesforce documents). A user without Read access to the event fails earlier, with `CUSTOM_LOG_SOURCE_UNAVAILABLE`.                                               | Ask an administrator why the security policy refuses the subscription, or pass another `--target-org`.                                                                                                                |
| `CUSTOM_LOG_CAPTURE_FAILED`        | `capture` stopped for a reason with no finer code. Core could not rebuild the connection after three attempts, Salesforce rejected the stored position twice in one run, or the transport failed in a way core does not classify. The message names the cause.                            | Run `capture` again. It resumes from the stored position.                                                                                                                                                             |
| `INVALID_ARGUMENT`                 | A record id is not 15 or 18 characters, an id for an event source is not an event id, `--since` or `--until` is neither a duration nor an ISO-8601 instant with an offset, or `--max-time` is out of range.                                                                               | Fix the value.                                                                                                                                                                                                        |
| `ABORTED`                          | The caller cancelled the operation.                                                                                                                                                                                                                                                       | Nothing.                                                                                                                                                                                                              |
