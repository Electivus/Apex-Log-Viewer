# CLI Guidelines

## Scope
- This file applies to `crates/cli/` and its child directories.

## Module Organization
- `src/` contains the CLI implementation.
- `tests/` contains CLI integration tests.

## Build and Test Commands
- `cargo build -p apex-log-viewer-cli` builds the Rust CLI.
- `cargo test -p apex-log-viewer-cli` runs CLI tests.

## Coding Style
- Follow standard `rustfmt` defaults.
- Keep naming and module organization idiomatic for Rust.

## Testing Guidelines
- Add/update tests in `tests/` for behavior changes.
- Run crate-level tests before submitting changes.
