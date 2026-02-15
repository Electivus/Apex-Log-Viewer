# Repository Guidelines

## Scope
- This file defines cross-repository guidance.
- Directory-specific guidance lives in nested `AGENTS.md` files and overrides this file when there is a conflict.

## Project Structure
- `apps/vscode-extension/` contains the VS Code extension and webview UI.
- `crates/cli/` contains the Rust CLI (`apex-log-viewer-cli`).
- `docs/` holds architecture/testing notes; `media/` stores bundled webview assets; `scripts/` contains tooling.

## Build and Development
- Use Node `22` via `.nvmrc` for JavaScript/TypeScript workflows.
- Extension-specific commands and coding rules are defined in `apps/vscode-extension/AGENTS.md`.
- CLI-specific commands and coding rules are defined in `crates/cli/AGENTS.md`.

## Commit and Pull Request Guidelines
- Use Conventional Commits (for example `feat(logs): add filter`, `fix(tail): handle missing CLI`).
- PRs should include build/test results.
- Update `CHANGELOG.md` for user-facing changes.
- Add screenshots/GIFs for UI changes.

## Security and Configuration Tips
- Salesforce CLI (`sf`/`sfdx`) is required for runtime usage.
- Never commit tokens or org-sensitive data.
- Keep logs under `apexlogs/`.
- `*.log` and `*.txt` are blocked by hooks/CI.
