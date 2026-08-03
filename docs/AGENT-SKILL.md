# Apex Log Viewer Agent Skill

The repository publishes one portable Agent Skill named `apex-log-viewer-cli` from `skills/apex-log-viewer-cli`. Its operational workflow uses the independently installed `@electivus/plugin-electivus` Salesforce CLI plugin. Agent-specific metadata is optional presentation metadata; `SKILL.md` remains the behavioral source of truth.

The package follows the [Agent Skills specification](https://agentskills.io) and uses the cross-agent [`skills` CLI](https://github.com/vercel-labs/skills) as its only installer, updater, remover, and agent-targeting authority.

## Preview and project installation

Run discovery before installing when you want to inspect the public identity and description:

```bash
npx skills add Electivus/Apex-Log-Viewer --list
```

From the Salesforce workspace that should share the skill, run:

```bash
npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli
```

Project scope is the default. The CLI detects installed agents or asks which agents to target, then uses its standard canonical-copy and link behavior with platform fallback. Do not force a vendor list or copy mode unless you have a separate reason to override the standard behavior.

Review and commit `skills-lock.json`. It records the repository source, selected skill, and computed content hash so teammates and automation can audit the installed dependency. A clone with the lockfile can restore project skills with the installer version supported by the project:

```bash
npx skills experimental_install
```

`experimental_install` is the command name in `skills@1.5.21`; review it when deliberately upgrading the pinned development contract.

## Global alternative

To make the Agent Skill available across workspaces, explicitly choose global scope:

```bash
npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli --global
```

Project installation remains the documented default because its lockfile is shareable and reproducible.

## Updates

Update a project installation only when the user intends to update the Agent Skill:

```bash
npx skills update apex-log-viewer-cli --project -y
```

For an intentionally global update, replace `--project` with `--global`. Ordinary Apex log investigation must not install, remove, or update the Agent Skill or the Salesforce CLI plugin.

The skill follows the repository's default branch. At runtime it starts with `sf electivus doctor --json`, reads the runtime version and environment, and checks command help before relying on an operation that an older plugin may not expose.

## Verify-first migration from the former installer

**Verify the portable installation before removing the legacy copy.** No project install, repository script, Salesforce command, or migration step automatically deletes files from an agent home.

1. Install the portable project-scoped package with the command above.
2. Run `npx skills list --json` from the project and confirm that `apex-log-viewer-cli` is listed for the intended agent.
3. Open the installed `SKILL.md` through the agent's project skill location and run its startup diagnostic, `sf electivus doctor --json`.
4. Locate the old global copy only after those checks pass. The former installer normally wrote `apex-log-viewer-cli` under the `skills` directory of `CODEX_HOME`, or under `.codex/skills` in the user profile when `CODEX_HOME` was not set.
5. Manually remove only that verified legacy directory. Keep the portable project installation and `skills-lock.json` intact.

If the old and new copies both remain visible, do not guess which one the agent loaded. Inspect the resolved project path and content before cleanup.

## Compatibility and catalog verification

The repository claims format compatibility across the Agent Skills ecosystem. Automated distribution tests use the pinned `skills@1.5.21` CLI and target Claude Code, Codex, GitHub Copilot, and Devin in isolated project roots; they do not launch proprietary agents or exercise live Salesforce org workflows inside each product.

After this source is merged, verify remote discovery with:

```bash
npx skills add Electivus/Apex-Log-Viewer --list
```

Then check the [Apex-Log-Viewer page on skills.sh](https://skills.sh/Electivus/Apex-Log-Viewer). Catalog appearance and ranking are post-merge observations driven by remote installation telemetry, not a separate submission API.
