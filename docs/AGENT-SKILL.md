# Electivus Debug and Agent Skills

The repository publishes three standalone Agent Skills from the canonical `skills/` catalog. Their operational workflow uses the independently installed `@electivus/plugin-electivus` Salesforce CLI plugin. Agent-specific metadata is optional presentation metadata; each `SKILL.md` remains the behavioral source of truth.

| Skill                    | Purpose                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `apex-log-viewer-cli`    | Operate the CLI, synchronize logs, inspect cache health and configure capture.                                |
| `apex-debug-investigate` | Find the responsible transaction, explain a functional failure, apply an authorized correction and verify it. |
| `apex-debug-performance` | Investigate CPU, SOQL/DML, heap and recursion; compare equivalent executions before and after a change.       |

```text
sf electivus log sync -> local corpus -> content search -> selected transactions
                                                        |
                                                        v
                                     evidence -> correction -> verification
```

For current org activity the agent syncs available logs in bulk, then searches their local bodies with `rg --no-ignore`. The canonical directory comes from `result.orgLogsRoot`; older plugins expose `apexlogsRoot` and `safeTargetOrg` through `log status`. The skills also cover legacy files, duplicate log IDs, caught exceptions, asynchronous boundaries and incomplete logs. Supplied files and offline investigations do not require org authentication.

`log sync --json` retains its existing fields and adds absolute `apexlogsRoot`, `orgLogsRoot`, and `failures` containing log IDs and stable error codes. `log status` adds `failedCount` and, when the local org identity is resolved, `orgLogsRoot`. A successful Salesforce CLI wrapper (`status: 0`) can still contain `result.status: "partial"`; inspect the inner result before judging coverage. An incremental sync does not prove complete historical coverage. `--force-full` reconciles retained history, but cannot recover logs expired from Salesforce.

Example requests:

- "Sync my sandbox logs and find why order ORDER-4821 failed. Fix the cause and run the relevant local tests."
- "Investigate this local log. Determine whether the exception was caught and cite the evidence."
- "Find which CheckoutService execution exhausted a limit, then compare it with the new capture."

Choose one distribution channel per destination: the full agent plugin below, the offline npm skill bundle, or the repository-based cross-agent [`skills` CLI](https://github.com/vercel-labs/skills). Loose skills follow the [Agent Skills specification](https://agentskills.io) and work without the MCP or sibling skills. Avoid loading both loose and plugin copies of the same skill.

## Complete agent plugin

`plugins/electivus-debug` is a self-contained generated plugin, versioned independently in `config/agent-plugin.json`. It ships the three skills and configuration for the official Certinia analyzer. The repository includes both Codex and Claude-compatible marketplace catalogs. The commands below work from the remote repository after these files are published.

| Client                    | Installation                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI / Codex app     | Add `Electivus/Apex-Log-Viewer` as a marketplace. Current CLI: `codex plugin marketplace add Electivus/Apex-Log-Viewer`, then `codex plugin add electivus-debug@electivus`. The app also exposes the plugin through its plugin browser. |
| Claude Code               | `/plugin marketplace add Electivus/Apex-Log-Viewer`, then `/plugin install electivus-debug@electivus`.                                                                                                                                  |
| GitHub Copilot CLI        | `copilot plugin marketplace add Electivus/Apex-Log-Viewer`, then `copilot plugin install electivus-debug@electivus`.                                                                                                                    |
| GitHub Copilot in VS Code | Add `Electivus/Apex-Log-Viewer` to `chat.plugins.marketplaces`, then locate `electivus-debug` using `@agentPlugins` in Extensions and install it. Requires a VS Code release with agent plugin support.                                 |

For local development, point Codex's marketplace command at this repository root. Claude Code and Copilot CLI accept `--plugin-dir ./plugins/electivus-debug`; VS Code supports the `chat.pluginLocations` map with the absolute bundle path set to `true`. Use loose skills in clients without plugin support, including the Codex IDE extension where full plugins are not supported. Restart or reload the client as its plugin manager requires.

### Optional Certinia MCP

The plugin configures `npx -y @certinia/apex-log-mcp@2.0.1 --no-apex-execution`. It references the official npm package; no third-party runtime is vendored. First startup needs npm access (or a configured mirror) and local Node.js 22.19+; Node 24 is recommended. Run the client and MCP in the same filesystem environment as the logs, and pass absolute paths. A Windows MCP process cannot read a WSL path such as `/home/k3/...` directly.

Use `apexlog_get_summary`, `apexlog_list_slow_operations`, and `apexlog_list_limit_risks` for selected local files. Clients can prefix tool names. The anonymous Apex tool can remain visible in discovery but execution is refused by the configured flag. Capture remains with `sf electivus`; the plugin does not add arbitrary Apex execution to the debugging workflow. If startup is unavailable, the skills continue with local searches and limit/event excerpts. Disable the plugin's MCP entry in the client if you already configured the same server separately.

The upstream server is BSD-3-Clause. Referencing or redistributing it is allowed under that license's conditions; retain its copyright, license and disclaimer when redistributing, and do not imply Certinia endorsement. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) includes the complete notice; our MIT license does not relicense upstream code. See the [upstream repository](https://github.com/certinia/debug-log-analyzer-mcp).

### Maintaining the bundle

Edit `skills/` and `config/agent-plugin.json`, then run:

```bash
pnpm run build:agent-plugin
pnpm run check:agent-plugin
pnpm run test:agent-plugin
pnpm run test:agent-plugin:mcp
```

Commit the generated bundle and both marketplace catalogs with their sources. Do not hand-edit generated copies. `plugin.json` and `mcp.json` follow [Agent Plugins 1.0](https://agent-plugins.org); `.codex-plugin`, `.claude-plugin`, and `.mcp.json` provide client compatibility. Each client sees one MCP definition through its supported format. CI rejects stale artifacts and tests the pinned MCP on synthetic logs. Update the agent plugin version deliberately, separately from the Salesforce CLI version. Use the client's plugin manager for updates; the loose-skill updater does not update a full plugin.

See [debugging validation](AGENT-DEBUG-VALIDATION.md) for reproducible fixtures, acceptance cases and the limits of automated coverage.

## Offline installation from the npm plugin

Use this path when GitHub clone/download access is blocked. npm (or a corporate mirror) is needed to acquire the plugin; the skill installation itself uses no network, Git, `npx`, or extra installer dependency.

```bash
sf plugins install @electivus/plugin-electivus
sf electivus skill install
sf electivus skill install --agent codex --agent claude-code --json
sf electivus skill install --all --agent codex --json
sf electivus skill install --skill apex-debug-investigate --skill apex-debug-performance --agent claude-code --json
sf electivus skill install --agent devin --global
sf electivus skill install --skills-dir ./custom-skills --dry-run
```

The menu highlights detected agents but always requires a choice. All four supported agents remain available even when not detected. Project scope defaults to the current directory; use `--workspace-root` for another existing project or `--global` for your profile. `--skills-dir` selects a custom parent directory and cannot be combined with agent/scope flags. Non-interactive runs and `--json` require an explicit destination. See the [packaged README](../packages/sf-plugin/README.md) for the directory mapping and complete output contract.

The installer copies the selected skills and their supporting resources. With no `--skill` or `--all`, it still installs only `apex-log-viewer-cli` and preserves the existing JSON shape. Explicit selection returns `{ pluginVersion, dryRun, skills: [...] }`, where every entry has the previous per-skill result shape. `--all` and `--skill` are mutually exclusive. All selected skills and destinations are checked before any write.

Reinstalling identical files changes nothing. Different files require `--force`; add `--dry-run` to preview that replacement without writing. Existing symlinks/junctions are rejected; inspect and migrate those installations explicitly rather than overwriting their targets. No npm lifecycle hook writes to an agent home. This offline channel installs skills, not an MCP server or full agent plugin.

To update a bundled installation, explicitly update the plugin through your approved npm registry, then repeat the original agent/scope/destination selection with `--force`:

```bash
sf plugins install @electivus/plugin-electivus@latest --force
sf electivus skill install --agent codex --force --json
```

The installed copy stays pinned to its plugin bundle until that second command is run. This channel does not write `skills-lock.json`; record the plugin version for reproducibility. Repository-installed copies continue to use the repository updater below. If the installation source is unknown, identify it before choosing an updater.

The explicit legacy `--codex-home <directory>` flag remains supported and deprecated. Unlike version 0.2.1, a bare `sf electivus skill install` asks for agents and defaults to project scope. JSON output now reports an `installations` array for multiagent results.

## Preview and project installation

Run discovery before installing when you want to inspect the public identity and description:

```bash
npx skills add Electivus/Apex-Log-Viewer --list
```

From the Salesforce workspace that should share the skill, run:

```bash
npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli
npx skills add Electivus/Apex-Log-Viewer --skill apex-debug-investigate --skill apex-debug-performance
```

Project scope is the default. The CLI detects installed agents or asks which agents to target, then uses its standard canonical-copy and link behavior with platform fallback. Do not force a vendor list or copy mode unless you have a separate reason to override the standard behavior.

Review and commit `skills-lock.json`. It records the repository source, selected skill, and computed content hash so teammates and automation can audit the installed dependency. A clone with the lockfile can restore project skills with the installer version supported by the project:

```bash
npx skills experimental_install
```

`experimental_install` is the command name in `skills@1.5.26`; review it when deliberately upgrading the pinned development contract.

## Global alternative

To make the Agent Skill available across workspaces, explicitly choose global scope:

```bash
npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli --global
```

Project installation remains the documented default because its lockfile is shareable and reproducible.

## Repository-based updates

Update a project installation only when the user intends to update the Agent Skill:

```bash
npx skills update apex-log-viewer-cli --project -y
```

For an intentionally global update, replace `--project` with `--global`. Ordinary Apex log investigation must not install, remove, or update the Agent Skill or the Salesforce CLI plugin.

The skills follow the repository's default branch. Before org operations they use `sf electivus doctor --json`, read the runtime version and environment, and check command help before relying on an operation that an older plugin may not expose. Supplied local logs can be investigated directly. Repeat updates for the skill names you installed.

## Verify-first migration from a legacy global installation

**Verify the portable installation before removing the legacy copy.** No project install, repository script, Salesforce command, or migration step automatically deletes files from an agent home.

1. Install the portable project-scoped package with your chosen channel above.
2. For repository installs, run `npx skills list --json`; for bundled installs, inspect the `installations` paths from the installer JSON. Confirm `apex-log-viewer-cli` for the intended agent.
3. Open the installed `SKILL.md` through the agent's project skill location and run its startup diagnostic, `sf electivus doctor --json`.
4. Locate the old global copy only after those checks pass. The legacy installer normally wrote `apex-log-viewer-cli` under the `skills` directory of `CODEX_HOME`, or under `.codex/skills` in the user profile when `CODEX_HOME` was not set.
5. Manually remove only that verified legacy directory. Keep the portable project installation and `skills-lock.json` intact.

If the old and new copies both remain visible, do not guess which one the agent loaded. Inspect the resolved project path and content before cleanup.

## Compatibility and catalog verification

The repository claims format compatibility across the Agent Skills ecosystem. Automated distribution tests use the exact `skills` version pinned in the root `package.json` and target Claude Code, Codex, GitHub Copilot, and Devin in isolated project roots; they do not launch proprietary agents or exercise live Salesforce org workflows inside each product.

After this source is merged, verify remote discovery with:

```bash
npx skills add Electivus/Apex-Log-Viewer --list
```

Then check the [Apex-Log-Viewer page on skills.sh](https://skills.sh/Electivus/Apex-Log-Viewer). Catalog appearance and ranking are post-merge observations driven by remote installation telemetry, not a separate submission API.
