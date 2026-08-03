# Use the skills CLI as the sole Agent Skill installer

Status: accepted

## Context

The Salesforce CLI plugin currently bundles the `apex-log-viewer-cli` skill and installs it only into the Codex home. Maintaining that installer beside the cross-agent `skills` CLI would duplicate installation and update behavior, keep the distribution coupled to one agent, and make compatibility claims ambiguous.

## Decision

The Apex Log Viewer Agent Skill will keep the public name `apex-log-viewer-cli`, live at `skills/apex-log-viewer-cli/` on the default branch, and use the `skills` CLI as its sole installer and updater. Project-scoped installation with interactive agent selection and the CLI's default link-or-copy behavior is the primary path; global installation remains an alternative, and project consumers are told to version `skills-lock.json`.

The `SKILL.md` and supporting resources must remain agent- and operating-system-neutral. Agent-specific metadata is allowed only as an optional enhancement that cannot affect behavior. Format compatibility applies broadly to agents supported by the `skills` CLI, while repository validation covers discovery and installation for Claude Code, Codex, GitHub Copilot, and Devin against an explicitly pinned development version of that CLI.

Because the skill and Salesforce CLI plugin can update independently, the skill must start with `doctor`, inspect the reported runtime version, and check command availability before relying on an operation. When the plugin is absent or incompatible, the skill may offer the exact install or update command but must obtain explicit user intent before executing it. Skill installation and legacy migration belong in product documentation; the installed skill discusses its own update only when the user asks to update it.

## Consequences

- `sf electivus skill install` and the plugin's bundled-skill packaging are removed.
- Existing Codex-only copies are removed only through a documented verify-first migration; the new flow never deletes them automatically.
- The README can expose the `skills.sh` badge and direct install command, but catalog appearance is verified only after the source is public and remote installation telemetry has indexed it.
