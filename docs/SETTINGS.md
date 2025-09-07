# Settings

The Electivus Apex Log Viewer extension exposes several settings under the `Electivus Apex Logs` section of the VS Code Settings UI. You can change them from `Preferences: Open Settings (UI)` or by editing your `settings.json` directly.

```jsonc
"electivus.apexLogs.pageSize": 100,
"electivus.apexLogs.headConcurrency": 5,
"electivus.apexLogs.saveDirName": "apexlogs",
"electivus.apexLogs.trace": false,
"electivus.apexLogs.tailBufferSize": 10000
```

## `electivus.apexLogs.pageSize`

- **Type**: number (10–200)
- **Default**: `100`
- Number of log headers fetched per page. Reduce this if large log sets cause slow loading, or increase it to load more logs at once.

## `electivus.apexLogs.headConcurrency`

- **Type**: number (1–20)
- **Default**: `5`
- Maximum number of concurrent requests when retrieving log headers. Lower values decrease load on the Salesforce APIs at the cost of slower fetches.

## `electivus.apexLogs.saveDirName`

- **Type**: string
- **Default**: `"apexlogs"`
- Folder name used when saving logs to disk. Files are placed under `${workspaceFolder}/.sflogs/<saveDirName>`.

## `electivus.apexLogs.trace`

- **Type**: boolean
- **Default**: `false`
- Enables verbose trace logging of CLI and HTTP interactions in the **Electivus Apex Log Viewer** output channel. Useful for troubleshooting issues with log retrieval or authentication.

## `electivus.apexLogs.tailBufferSize`

- Type: number (1000–200000)
- Default: `10000`
- Maximum number of lines retained in the Tail view's rolling buffer. Higher values keep more history visible to filters and search, at the cost of additional memory.
- Changes take effect immediately in an open Tail view; no reload required.

## Applying changes

After adjusting settings, reload the VS Code window to ensure the extension picks up the new configuration (`Developer: Reload Window`).
