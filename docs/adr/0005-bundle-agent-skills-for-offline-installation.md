# Bundle Agent Skills for offline installation

Status: accepted; supersedes the exclusive distribution policy in ADR 0002.

## Context

Corporate environments may allow npm or an internal registry while blocking GitHub cloning and downloads. Requiring a repository retrieval prevents those users from installing the Agent Skill even when the Salesforce plugin is available.

## Decision

Keep `skills/` as the sole portable source and copy its complete catalog into the plugin npm artifact during build. `sf electivus skill install` installs the bundled `apex-log-viewer-cli` through local filesystem operations only. The installer belongs to the Salesforce CLI adapter, not the shared Salesforce core or either IDE.

Project scope is the default, with explicit global and custom directories. The interactive menu highlights locally detected agents and requires selection; automation specifies destinations with flags. Presets cover Claude Code, Codex, GitHub Copilot and Devin. Physical copies avoid runtime dependencies on a plugin installation path or Windows symlink privileges. Identical copies are unchanged; different content requires `--force`, and replacement preserves a recoverable previous copy when promotion fails.

The repository-based `skills` CLI remains supported. Each destination has one installer lifecycle: the plugin installer does not maintain `skills-lock.json`, and no npm lifecycle hook installs or updates an agent copy. Updating the plugin and reinstalling its skill are distinct explicit operations. Existing explicit `--codex-home` invocations remain available as a deprecated compatibility path.

## Consequences

- npm acquisition is the only network requirement for the bundled channel; installation never falls back to GitHub, Git, `npx`, or the working directory.
- Bundled snapshots follow plugin versions; repository-installed copies can evolve independently. Startup capability checks remain necessary.
- Installer, package, and release tests cover the extracted npm artifact and deny network/subprocess calls during skill installation.
- Consumers upgrading from 0.2.1 must account for interactive selection, project scope, and the multiagent JSON result.
