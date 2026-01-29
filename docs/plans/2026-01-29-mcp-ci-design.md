# MCP CI Workflow Design

## Goal
Add a dedicated GitHub Actions workflow to build and test the MCP package whenever its files change.

## Summary of Decisions
- **Workflow:** New file at `.github/workflows/mcp-ci.yml`.
- **Triggers:** `push` and `pull_request` with `paths` filters for `.github/**` and `apps/sf-plugin-apex-log-viewer-mcp/**`.
- **Runner:** `ubuntu-latest` with Node 22.
- **Commands:** `npm ci --workspaces=false`, `npm run build`, `npm test` in `apps/sf-plugin-apex-log-viewer-mcp`.
- **Caching:** `actions/setup-node` with npm cache keyed by `apps/sf-plugin-apex-log-viewer-mcp/package-lock.json`.
- **Permissions:** `contents: read` only.
- **Concurrency:** One run per workflow/ref to avoid duplicate work.

## Architecture
The workflow runs a single job dedicated to the MCP package. It checks out the repo, sets up Node 22 with npm caching, installs dependencies, builds the TypeScript output, and runs the MCP test suite. A path filter ensures the workflow runs only when MCP-related files or workflow files change.

## Build & Test
- `npm ci --workspaces=false`
- `npm run build`
- `npm test`

## Documentation Updates
Update `docs/CI.md` to list the MCP CI workflow and its triggers.

