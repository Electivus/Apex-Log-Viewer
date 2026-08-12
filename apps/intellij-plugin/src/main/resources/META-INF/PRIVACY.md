# Privacy

The IntelliJ plugin sends no telemetry and makes no analytics requests. It connects only to the Salesforce organizations selected by the user through the locally installed Salesforce CLI, and it stores downloaded Apex logs inside the current project under `apexlogs/`.

The sanitized diagnostics export is created only on explicit request. It excludes source code, Apex log content, search terms, usernames, aliases, organization identifiers, instance URLs, access tokens, and local paths.
