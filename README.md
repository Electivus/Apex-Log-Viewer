# Apex Log Viewer Tools

Monorepo for the Electivus Apex Log Viewer ecosystem.

## Structure

- `apps/vscode-extension/` – VS Code extension.
- `crates/cli/` – Rust CLI (`apex-log-viewer`).
- `docs/` – shared documentation and design notes.

## CLI (Rust)

Build:

```bash
cargo build -p apex-log-viewer-cli
```

Run:

```bash
apex-log-viewer logs sync --limit 100 --target <alias|username>
```

`logs sync` creates `apexlogs/` under the current working directory and stores the latest logs there.

## VS Code Extension

See `apps/vscode-extension/README.md` for development and usage.
