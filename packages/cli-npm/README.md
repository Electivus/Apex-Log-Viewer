# CLI npm Packaging

This workspace directory contains the templates and launcher used to stage the published npm packages for the Apex Log Viewer CLI.

- `@electivus/apex-log-viewer` is the meta package with the launcher entrypoint.
- `@electivus/apex-log-viewer-<platform>-<arch>` packages contain the platform-specific native binaries.

Use `node scripts/build-cli-npm-packages.mjs` to generate a staging directory from already-built CLI binaries.
