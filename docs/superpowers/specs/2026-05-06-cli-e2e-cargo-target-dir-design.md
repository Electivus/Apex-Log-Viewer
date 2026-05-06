# CLI E2E Cargo target-dir compatibility design

## Context

PR #783 moves Cargo build output away from the default `target/` directory by
adding `.cargo/config.toml` with `build.target-dir = "../.cargo-target/Apex-Log-Viewer"`.
The runtime binary copy script already resolves Cargo's effective target
directory with `cargo metadata`, but the CLI Playwright E2E bootstrap still
expects the standalone debug binary at `target/debug/apex-log-viewer`.

The failing GitHub Actions check is `Playwright E2E (scratch org)`. Its log
shows that `npm run build:runtime` finished compiling the CLI, then
`scripts/run-playwright-cli-e2e.js` failed because `target/debug/apex-log-viewer`
did not exist.

## Goal

Make the CLI E2E bootstrap and helper utilities locate the standalone CLI binary
from Cargo's effective target directory while preserving the legacy
`target/debug` lookup for existing local workflows.

## Non-goals

- Do not change the new Cargo target directory strategy.
- Do not copy or symlink Cargo artifacts back into `target/debug`.
- Do not change scratch-org allocation, proxy-lab behavior, or Playwright test
  coverage beyond binary resolution.

## Design

Update `scripts/run-playwright-cli-e2e.js` so it can resolve Cargo's effective
target directory by running:

```bash
cargo metadata --format-version=1 --no-deps
```

The wrapper will build the accepted standalone binary paths from that
`target_directory`, using the host debug binary name (`apex-log-viewer` or
`apex-log-viewer.exe`). It will keep `target/debug/<binary>` as a fallback so
older layouts and simple test fixtures continue to work.

When `ensureBuildArtifacts()` invokes `npm run build:runtime`, it will continue
to clear `CARGO_BUILD_TARGET` so the build produces a host debug binary. After a
successful build, it will re-check the accepted paths. Before launching
Playwright, the wrapper will pass the resolved CLI binary path through an
environment variable such as `ALV_CLI_BINARY_PATH`.

Update `test/e2e/cli/utils/cli.ts` to prefer `ALV_CLI_BINARY_PATH` when present
and otherwise fall back to its existing `target/debug` lookup. The helper should
validate that the env-var path exists before using it, and error messages should
include both the explicit path and fallback candidates when resolution fails.

## Error handling

- If `cargo metadata` fails before the build, the wrapper may fall back to the
  legacy `target/debug` candidate so tests in minimal fixtures remain cheap.
- If `npm run build:runtime` succeeds but no accepted binary exists, fail with a
  diagnostic listing all checked paths.
- If `ALV_CLI_BINARY_PATH` is set but missing, the CLI helper fails clearly
  rather than silently using a different binary.

## Verification

- Add focused Node tests for `scripts/run-playwright-cli-e2e.js` covering Cargo
  target-dir candidates and `ALV_CLI_BINARY_PATH` propagation.
- Add focused CLI helper tests covering `ALV_CLI_BINARY_PATH` success and
  missing-path diagnostics.
- Run `node --test scripts/run-playwright-cli-e2e.test.js`.
- Run the broader script regression command if the focused tests pass.
- Push the fix and resume the PR watcher.
