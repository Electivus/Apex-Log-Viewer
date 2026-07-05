# CLI npm Packaging

This workspace directory contains the native package templates and legacy launcher used by the Apex Log Viewer Rust runtime npm packaging.

- `@electivus/plugin-electivus` is the Salesforce CLI plugin package users install with `sf plugins install @electivus/plugin-electivus`.
- `@electivus/apex-log-viewer-<platform>-<arch>` packages contain the platform-specific native binaries.
- `@electivus/apex-log-viewer` is the old meta binary package and should be deprecated after cutover.

Use `npm run build:cli:npm` to compile the plugin and generate a staging directory from already-built CLI binaries.
