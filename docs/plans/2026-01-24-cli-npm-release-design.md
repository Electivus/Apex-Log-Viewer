# CLI NPM Release CI Design

**Goal:** Publish the Rust CLI to npm using platform-specific packages plus a wrapper package, with a GitHub Actions CI that is secure and repeatable.

## Context
We ship a Rust CLI in `crates/cli`. We want npm distribution that does not rely on postinstall downloads and supports multiple OS/arch combinations.

## Decisions
1. **Package model:** Use a wrapper package `@electivus/apex-log-viewer-cli` plus six platform packages (`-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`, `-win32-x64`, `-win32-arm64`).
2. **Bin name:** Expose `apex-log-viewer` as the CLI executable in the wrapper and platform packages.
3. **Release trigger:** Publish on tags matching `cli-v*` with a version check against `crates/cli/Cargo.toml`.
4. **Security:** Use minimal permissions and npm provenance via OIDC (`id-token: write`). Secrets used only in publish jobs.

## Architecture & Data Flow
- Tag push `cli-vX.Y.Z` starts the workflow.
- Matrix build compiles `cargo build --release --target <triple>` for each platform.
- Each build creates a platform npm package containing `package.json`, `LICENSE`, `README.md`, and `bin/apex-log-viewer[.exe]`.
- Platform packages are published first. The wrapper is published last with `optionalDependencies` referencing all platform packages and a JS shim that resolves and executes the installed binary.

## Error Handling
- Fail fast if tag version != `Cargo.toml` version.
- Fail if the expected binary is missing or not executable.
- Wrapper errors clearly if the current OS/arch has no supported package.

## Testing Strategy
- Keep `cargo test -p apex-log-viewer-cli` in `ci.yml` for every change.
- In release workflow, run a lightweight smoke (`apex-log-viewer --help`) before packaging.

## Non-Goals
- Implementing new CLI features.
- Changing VS Code extension release workflows.
