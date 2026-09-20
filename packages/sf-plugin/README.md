# `@electivus/plugin-electivus`

Salesforce CLI plugin for Apex Log Viewer terminal workflows. It exposes the class-per-command `sf electivus ...` surface backed by the private shared TypeScript core.

```bash
sf plugins install @electivus/plugin-electivus
sf electivus doctor --json
```

## Bundled Agent Skill (no GitHub access required)

After installing the plugin from npm or your corporate npm mirror, install its bundled `apex-log-viewer-cli` skill without network access:

```bash
sf electivus skill install
sf electivus skill install --agent codex --agent claude-code --json
sf electivus skill install --agent github-copilot --global
sf electivus skill install --agent devin --workspace-root ./my-project
sf electivus skill install --skills-dir ./custom-skills --dry-run
```

Without a destination, an interactive menu highlights detected agents and requires a selection. Project scope is the default. CI, redirected terminals and `--json` require `--agent` or `--skills-dir`. Repeated `--agent` flags support multiple agents; shared destinations are written once. `--skills-dir` is the parent directory, so the installer appends `apex-log-viewer-cli`.

| Agent          | Project directory | Global directory                                                  |
| -------------- | ----------------- | ----------------------------------------------------------------- |
| Claude Code    | `.claude/skills`  | `$CLAUDE_CONFIG_DIR/skills`, default `~/.claude/skills`           |
| Codex          | `.agents/skills`  | `$CODEX_HOME/skills`, default `~/.codex/skills`                   |
| GitHub Copilot | `.agents/skills`  | `~/.copilot/skills`                                               |
| Devin          | `.devin/skills`   | `$XDG_CONFIG_HOME/devin/skills`, default `~/.config/devin/skills` |

The installer copies all bundled resources. Identical content is unchanged. Different content requires `--force`, including when previewing with `--dry-run`. Replacement removes stale files only inside the selected skill directory and preserves the previous copy if promotion fails. Symlinks/junctions and special files in an existing skill are refused even with `--force`; other skills remain untouched. Multiple destinations are preflighted together; if a later write fails, the error lists completed destinations so you can retry safely. If temporary-directory cleanup fails after a successful installation, that destination retains its successful status and includes a `warnings` entry with the cleanup path; the remaining destinations still run.

Update the plugin through your approved npm registry, then rerun the same skill installation with `--force`. Plugin updates alone do not modify installed skills. The offline installer does not create or modify `skills-lock.json`; do not mix it with the repository installer for the same destination. Copies created by the standard `skills` CLI retain that CLI's update lifecycle.

The old explicit `--codex-home <directory>` option still installs under `<directory>/skills`; it is deprecated and exclusive of the new destination flags. A bare invocation now asks for agents and defaults to the current project instead of silently installing globally for Codex. JSON output contains `skillName`, `pluginVersion`, `source`, `files`, `dryRun`, and `installations` (agents, scope, destination and status).

The repository-based installer remains available; see the [installation and migration guide](https://github.com/Electivus/Apex-Log-Viewer/blob/main/docs/AGENT-SKILL.md).
