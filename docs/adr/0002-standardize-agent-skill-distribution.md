# Standardize Agent Skill distribution on the cross-agent skills CLI

Status: accepted

## Context

The Apex Log Viewer Agent Skill contains portable `sf electivus` workflows, but its source and installer were coupled to one agent. The Salesforce CLI plugin copied a bundled instruction package into an agent home, creating a second lifecycle for installation, replacement, packaging, updates, and cleanup. The Agent Skill and Salesforce plugin also release independently, so file co-location did not guarantee runtime compatibility.

## Decision

The canonical `apex-log-viewer-cli` source lives in the repository's top-level `skills/` catalog and follows the common Agent Skills format. The cross-agent `skills` CLI is the sole public authority for discovery, project or global installation, agent targeting, linking or copying, updates, removal, and lockfile state.

Project-scoped installation is the primary path and consumers version `skills-lock.json`. A global installation remains an explicit alternative. The repository validates discovery and representative installation for Claude Code, Codex, GitHub Copilot, and Devin with a pinned real `skills` CLI, while describing broader support as format compatibility.

The Salesforce CLI plugin no longer exposes an Agent Skill installer or bundles Agent Skill files in its npm artifact. Legacy cleanup is verify-first and manual; no new code deletes an existing agent-home copy.

The Agent Skill and Salesforce plugin continue to update independently. Operational workflows start with `sf electivus doctor --json`, read the reported runtime and environment, verify command availability, and require explicit user intent before executing environment-changing installation or update commands.

Optional agent-specific metadata can enhance presentation or discovery, but it is non-authoritative and cannot change the behavior defined by `SKILL.md`.

## Consequences

- One canonical package serves Agent Skills-compatible clients without permanent vendor variants.
- The Salesforce CLI plugin owns Salesforce operations instead of agent filesystem distribution.
- Project installations are reproducible through a committed lockfile and the installer's standard link-or-copy fallback.
- Agent Skill and plugin updates can drift, so capability checks remain part of every operational startup.
- Existing users must verify the portable installation before manually removing a legacy global copy.
- skills.sh discovery and ranking can only be verified after merge and remote installation telemetry.
