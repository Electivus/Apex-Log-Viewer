# Custom Logs

Custom Logs reads application logs that a logging framework stores in Salesforce records, such as the `Log__c` and `LogEntry__c` records of Nebula Logger. It has two surfaces over one core:

- The **Custom Logs** panel in VS Code, in the bottom panel area next to Logs and Tail.
- The `sf electivus custom-log` commands of the Salesforce CLI plugin: `sources`, `list`, `get`, and `entry`.

Both surfaces read the same mapping from `sfdx-project.json` and return the same data. Custom Logs only reads. It writes nothing to Salesforce, and it keeps no copy of custom-log records on disk.

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

A source names the objects that hold the logs and says what each field means. Every source has one of two shapes:

- `transactions`: a header object with one record per transaction, and an entry object whose records point to their header. Nebula Logger has this shape. A list row is one header record.
- `entries`: one object with one record per log call. A list row is one entry record. Opening a row shows every entry that has the same transaction id. When the source maps no `transactionId`, or the record has no value, the transaction is that one entry.

### Built-in Nebula Logger sources

Nebula Logger needs no configuration. Custom Logs has one built-in source for each distribution:

| Source id        | Distribution                            | Objects                                    |
| ---------------- | --------------------------------------- | ------------------------------------------ |
| `nebula`         | Unlocked package or source deploy       | `Log__c` and `LogEntry__c`                 |
| `nebula-managed` | Managed package with namespace `Nebula` | `Nebula__Log__c` and `Nebula__LogEntry__c` |

Detection uses two Tooling API metadata queries. `EntityDefinition` confirms that both objects exist. `FieldDefinition` then checks that the entry object has the fields `Log__c`, `TransactionEntryNumber__c`, `LoggingLevelOrdinal__c`, and `EpochTimestamp__c`. An unrelated object that is also named `Log__c` fails that check. `FieldDefinition` lists fields regardless of field-level security, so hiding one of those fields from a user does not hide Nebula Logger from that user.

An org with both distributions shows both sources. Result keys use the unprefixed field names on both: `extra.Status__c`, `entryColumns[].key`, and detail keys such as `StackTrace__c` are the same on an unlocked and a managed org.

The built-in sources map no JSON payload. To add one, [replace the built-in source](#replace-a-built-in-nebula-source).

### Source states

`sf electivus custom-log sources --json` returns every source with its `state`. The panel shows the same states.

| State                                     | Meaning                                                                                                   | What to do                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ready`                                   | The objects exist, the user can read them, and every required field is readable and has an accepted type. | Nothing.                                                                                       |
| `notInstalled`                            | Built-in sources only. The org has no objects for this distribution.                                      | Nothing. An org with one Nebula distribution shows the other one as `notInstalled`.            |
| `notInstalled` with `"hint": "collision"` | The org has a `Log__c` object, but it is not Nebula Logger.                                               | Map that object as a project source. The hint goes away when a project source maps the object. |
| `unavailable`                             | Custom Logs cannot read the source. `reason` and `message` say why.                                       | See the next table.                                                                            |

| `reason`               | Meaning                                                                                                                                               | What to do                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `objectNotFound`       | Project sources only. A mapped object does not exist in this org.                                                                                     | Check the object API name in the mapping and the target org.                                                    |
| `objectNotReadable`    | The object exists, but describe does not return it for this user.                                                                                     | Give the user read access to the object, for example with a permission set that the logging framework provides. |
| `requiredFieldMissing` | A required field (`entry.fields.time`, `entry.fields.message`, `entry.parent`, or `transaction.fields.startTime`) is absent or hidden from this user. | Fix the field name, or give the user read access to the field.                                                  |
| `fieldTypeMismatch`    | A role, detail, flag, or payload names a field of a type that the key does not accept.                                                                | Map a field of an accepted type. See [Roles](#roles).                                                           |
| `metadataQueryRefused` | Salesforce refused the `EntityDefinition` or `FieldDefinition` query for this user. Custom Logs does not try another method.                          | Run as a user who has API access and can query those Tooling API objects.                                       |

Each source in the `sources` result also has these fields:

| Field            | Meaning                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `origin`         | `builtin`, or `config` for a project source. A project source that replaces a built-in source is `config`.                                                                                             |
| `shape`          | `transactions` or `entries`.                                                                                                                                                                           |
| `namespace`      | `Nebula` for `nebula-managed`. Absent otherwise.                                                                                                                                                       |
| `objects`        | The object API names the source reads. For a `notInstalled` source, the names that detection looked for.                                                                                               |
| `hiddenFields`   | Mapping paths that Custom Logs dropped because describe does not return the field for this user. See [Permissions](#permissions).                                                                      |
| `unmappedLevels` | Values of the level picklist that no level table maps. A level filter never matches them. See [Levels](#levels).                                                                                       |
| `capabilities`   | `levelFilter` says whether `--min-level` works, and `userFilter` whether `--user` works. `apexLogLink` says whether the listed object maps `requestId`, so that `get` can look for the Apex debug log. |
| `payload`        | The mapped JSON payload field and its default columns, under `transaction`, `entry`, or both. An empty object when the source maps none.                                                               |

The result also has `projectFile` (the `sfdx-project.json` that was read), `issues` (see [Configuration issues](#configuration-issues)), and `defaultSourceId` when exactly one source is ready.

### Which source a command reads

- `list` and `get --transaction-id` read the source that `--source` names. Without `--source`, they read the only ready source. When several sources are ready, they fail with `CUSTOM_LOG_SOURCE_REQUIRED` instead of picking one. A script that omits `--source` therefore never starts to read another source after someone adds one to the project.
- `get --log-id` and `entry` find the source from the 3-character key prefix of the record id. With `--source`, the id must belong to that source. Project sources come before built-in sources when two sources map the same object.

### When changes take effect

Every command and every panel refresh reads `sfdx-project.json` again, so a mapping edit applies to the next call. Core caches the detection and describe answers in memory for each user, including the answers that found nothing. The CLI starts every run with an empty cache. The extension keeps one cache while the extension host runs. If Salesforce rejects a query with `INVALID_FIELD` or `INVALID_TYPE` because the schema or the user's permissions changed, core drops that user's cache, resolves the sources again, and retries once.

## Map a source in sfdx-project.json

Project sources live in `sfdx-project.json` under `plugins.electivus.customLogs.sources`. Salesforce reserves the `plugins` key for Salesforce CLI plugin settings, and its own schema and validator accept any content under that key. The CLI reads the `sfdx-project.json` of the project that contains the current directory. The extension reads the `sfdx-project.json` of the Salesforce project open in VS Code. Without a project, only the built-in sources apply.

The extension validates and completes this block in the editor with the schema `sfdx-project.electivus.schema.json`. On completion, the schema offers two source skeletons, one for each shape.

### Source keys

| Key           | Required | Value                                                                                                                                                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Yes      | Lower-case letters, digits, and hyphens, starting with a letter, 40 characters at most. `--source` takes it. A project source that reuses `nebula` or `nebula-managed` replaces that built-in source. |
| `label`       | No       | Display name, 80 characters at most. The default is the `id`.                                                                                                                                         |
| `transaction` | No       | The header object. Its presence makes the source a `transactions` source.                                                                                                                             |
| `entry`       | Yes      | The entry object.                                                                                                                                                                                     |
| `levels`      | No       | Raw level values mapped to canonical levels. See [Levels](#levels).                                                                                                                                   |

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

### Field paths

A field path is a field API name, such as `Message__c`, or one relationship hop, such as `CreatedBy.Username`. Write the names as they are in the org. Custom Logs does not add a namespace prefix to a project source, so a field of a managed package keeps its prefix in the mapping, as in `Nebula__Message__c`.

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

A raw value that no table maps has no `level`, and a level filter never matches it. Entries keep the stored value in `rawLevel`. When the level field is a picklist, `sources` lists its values that no table maps in `unmappedLevels`.

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

- The org picker. The **Source** list appears next to it when more than one source is ready.
- **Refresh** reloads the list.
- **Open in editor** opens the same list in an editor tab.
- **Configure** opens the Custom Logs mapping in `sfdx-project.json`.

When no source is ready, the panel says why, with the state of each source and the configuration issues. The filter bar takes conditions in the form `field operator value`, joined by `and`. See [Filters and sorts run over loaded rows](#filters-and-sorts-run-over-loaded-rows). **+ Field** adds a payload path as a column. Selecting a row shows its payload as a tree. Each value in the tree has **+ Column**, which adds its path as a column, and **= value**, which adds a filter on that value. **Load more** reads the next page.

Opening a row opens the transaction in an editor tab. The viewer shows the header, the entries in transaction order, a level filter, a long-field filter, and a search over the loaded entries. Logger system messages stay hidden until you turn on **Show logger system messages**. Selecting an entry lists its long fields with their states, and opening one shows it in a read-only editor document. **Open Apex log** opens the debug log of the same request when the link is `linked`.

## JSON payloads

Core decodes each mapped payload field once, so the panel, the transaction viewer, and the CLI see the same values. Each row or entry with a mapped payload has a `payload` with one of these states:

| State     | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `parsed`  | The value is a JSON object or array. `values` holds its scalar leaves. |
| `invalid` | The value starts with `{` or `[` but is not valid JSON.                |
| `text`    | The value is plain text, or a JSON scalar such as `42`.                |
| `empty`   | The field has no value.                                                |
| `hidden`  | Field-level security hides the payload field from this user.           |

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

The panel groups array indexes as `[]`, so `[].status >= 500` matches a row when any item has a status of at least 500, and `[0].status` reads the first item only. Quote a path that contains a space, a quote, or one of `<`, `>`, `=` and `!`, as in `"Account Name" = Acme`. The suggestions of the filter input and the **Filter by this field** item of a column menu write the quotes for you.

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

## Link to the Apex debug log

`get` looks for the Apex debug log of the same request. It matches `ApexLog.RequestIdentifier` with the row's `requestId`, which for Nebula Logger is `Log__c.RequestId__c`. The result is in `apexLog`:

| `state`       | Meaning                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `linked`      | `logId` is the `ApexLog` id. `startTime` and `logLength` are present when Salesforce returns them.                 |
| `notFound`    | The user can read `ApexLog`, and none matches. No trace flag was active, or Salesforce already deleted the log.    |
| `unavailable` | `reason` is `noAccess`. The user cannot read `ApexLog` in this org, so the absence says nothing about the request. |
| `noRequestId` | The source maps no `requestId`, the field is hidden, or this record has no value.                                  |

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

The commands have no project flag. They read the `sfdx-project.json` of the project that contains the current directory, as `sf project deploy` does.

- `--min-level` keeps rows at or above a level. A transaction counts at its highest level. Values are `FINEST`, `FINER`, `FINE`, `DEBUG`, `INFO`, `WARN`, and `ERROR`.
- `--user` takes an exact username. The match ignores case.
- `--since` keeps rows at or after a time, and `--until` keeps rows before a time. Each takes a duration before now (a positive whole number followed by `m`, `h`, or `d`, such as `30m`, `24h`, or `7d`) or an ISO-8601 instant with an offset, such as `2026-10-29T12:00:00Z`. A bare date such as `2026-10-29` means midnight UTC.
- `--payload-fields` takes paths separated by commas, and you can repeat it. Paths match exactly.
- `--transaction-id` takes the framework's own transaction id, such as Nebula's `TransactionId__c`. For an `entries` source, `get` then pages every entry with that transaction id.
- `get --log-id` takes a list row `id`. For an `entries` source, any entry id of the transaction works.

List rows are ordered by `CreatedDate`, newest first, then by `Id`, because `CreatedDate` always has a value. A row shows its mapped time, so two rows logged seconds apart can appear out of order by that time. An `entries` source lists every entry as its own row.

Paging is by cursor. When `nextCursor` is not `null`, pass it back with `--cursor` and the same filter flags to read the next page. `--limit` can change between pages. A cursor is bound to the org, the source, the source's mapping, the kind of page, and the filters. A list cursor also carries the time window that `--since` resolved on the first page, so `--since 24h` does not move between pages.

`get` returns at most the first 2,000 characters of each message. `entry` returns the full message, every mapped detail with its state (`value`, `empty`, or `hidden`), and the raw payload. Entries with `system: true` are the logging framework's own bookkeeping, such as Nebula Logger's messages that start with `Nebula Logger - `.

With `--json`, a failed command exits with a non-zero status, and the JSON output has the error code in `code`.

## Error codes

| Code                               | Cause                                                                                                                                                                                         | What to do                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CUSTOM_LOG_NO_SOURCE`             | No source is ready, and the command named none.                                                                                                                                               | Run `sf electivus custom-log sources` and fix the state that each source reports.                         |
| `CUSTOM_LOG_SOURCE_REQUIRED`       | Several sources are ready, and the command named none. The message lists their ids.                                                                                                           | Pass `--source`.                                                                                          |
| `CUSTOM_LOG_SOURCE_NOT_FOUND`      | `--source` names an unknown id, no ready source owns the record id's key prefix, or the id does not belong to the `--source` source.                                                          | Check the id with `sources`, and check that the record id comes from this org.                            |
| `CUSTOM_LOG_SOURCE_UNAVAILABLE`    | `--source` names a source that is `notInstalled` or `unavailable`. The message gives the reason.                                                                                              | Fix the cause that `sources` reports, or pick a ready source.                                             |
| `CUSTOM_LOG_RECORD_NOT_FOUND`      | The record or transaction id does not exist, or this user cannot read it. Also returned when `get --log-id` receives an entry id of a `transactions` source, or `entry` receives a header id. | Check the id. For a `transactions` source, pass the header id to `get`, which `entry` returns as `logId`. |
| `CUSTOM_LOG_AMBIGUOUS_TRANSACTION` | Several headers have the requested transaction id. The message lists their ids.                                                                                                               | Pass one of them with `--log-id`.                                                                         |
| `CUSTOM_LOG_UNSUPPORTED_FILTER`    | The source lacks a role that the filter needs. `--min-level` needs a level mapping, `--user` needs a `user` role, and a transaction id lookup needs a filterable `transactionId` role.        | Remove the filter, or map the missing role in `sfdx-project.json`.                                        |
| `CUSTOM_LOG_INVALID_CURSOR`        | The cursor is malformed, or it comes from another org, another source, an older mapping, another kind of page, or other filters.                                                              | Run the command again without `--cursor`.                                                                 |
| `INVALID_ARGUMENT`                 | A record id is not 15 or 18 characters, or `--since` or `--until` is neither a duration nor an ISO-8601 instant with an offset.                                                               | Fix the value.                                                                                            |
| `ABORTED`                          | The caller cancelled the operation.                                                                                                                                                           | Nothing.                                                                                                  |
