# Apex Log Viewer Tools

Monorepo for the Electivus Apex Log Viewer ecosystem.

## Structure

- `apps/vscode-extension/` – VS Code extension.
- `docs/` – shared documentation and design notes.

## CLI (sf plugin)

Install:

```bash
sf plugins install @electivus/sf-plugin-apex-log-viewer
```

Run:

```bash
sf apex-log-viewer logs sync --target-org myOrg --limit 100 --output-dir apexlogs
```

## VS Code Extension

See `apps/vscode-extension/README.md` for development and usage.
