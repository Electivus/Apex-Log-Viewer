# MCP NPM First Release Design

## Goal
Publish the first public release of `@electivus/sf-plugin-apex-log-viewer-mcp` via a dedicated GitHub Actions workflow triggered by `mcp-v*` tags.

## Summary of Decisions
- **Tag pattern:** `mcp-vX.Y.Z` to avoid conflicts with existing `v*` and `sf-plugin-v*` workflows.
- **Workflow:** new `.github/workflows/mcp-npm-release.yml` that builds, tests, validates tag/version, and publishes to npm.
- **Version guardrails:** tag version must match `apps/sf-plugin-apex-log-viewer-mcp/package.json`.
- **Source guardrails:** tag commit must be on `main`.
- **Publish mode:** `npm publish --provenance --access public` using `NPM_TOKEN`.
- **Docs:** update `docs/PUBLISHING.md` and `docs/CI.md` to document MCP release flow.
- **Package config:** add `publishConfig.access = "public"` to the MCP package for first release safety.

## Architecture
The MCP npm release workflow runs on `mcp-v*` tag pushes. It checks out the repository with full history, configures Node 22 with npm cache keyed to the MCP `package-lock.json`, and installs dependencies in `apps/sf-plugin-apex-log-viewer-mcp`. It then runs `npm run build` and `npm test`. The workflow validates that the tag version equals the MCP package version and that the tag commit is an ancestor of `origin/main`. If validation passes, it publishes to npm with provenance and `--access public` using the `NPM_TOKEN` secret and `id-token: write` permissions.

## Release Steps (Operator)
1. Merge the MCP release workflow changes to `main`.
2. Ensure `apps/sf-plugin-apex-log-viewer-mcp/package.json` version is `0.1.0`.
3. Create tag `mcp-v0.1.0` on the `main` commit and push the tag.
4. Monitor the `MCP NPM Release` workflow for a successful publish.

## Risks & Mitigations
- **Scoped package defaults to private:** enforce `publishConfig.access = "public"` and `npm publish --access public`.
- **Accidental release from non-main:** workflow blocks tags not on `main`.
- **Version/tag mismatch:** workflow validates tag vs package.json.
