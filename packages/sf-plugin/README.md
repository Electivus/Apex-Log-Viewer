# `@electivus/plugin-electivus`

Salesforce CLI plugin for Apex Log Viewer terminal workflows. It exposes the class-per-command `sf electivus ...` surface backed by the private shared TypeScript core.

```bash
sf plugins install @electivus/plugin-electivus
sf electivus doctor --json
```

The plugin package contains Salesforce and local-log commands only. The independently distributed Apex Log Viewer Agent Skill is installed through the standard `skills` CLI; see the [installation and migration guide](https://github.com/Electivus/Apex-Log-Viewer/blob/main/docs/AGENT-SKILL.md).
