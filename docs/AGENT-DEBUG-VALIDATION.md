# Agent debugging validation

## Reproduce the automated checks

```bash
pnpm install --frozen-lockfile
pnpm run build:agent-plugin
pnpm run check:agent-plugin
pnpm run test:agent-plugin
pnpm run test:agent-plugin:mcp
pnpm run test:core
pnpm run test:sf-plugin
node --test scripts/skills-distribution.test.js scripts/sf-plugin-skills-package.test.js
```

The MCP check starts the exact configured npm package over stdio, initializes MCP, discovers its tools and calls them on synthetic files. It asserts that a fatal error is reported, a caught exception is not classified as fatal, the SOQL limit is reported, slow operations can be inspected, incomplete logging is visible, and anonymous Apex execution is refused. It requires npm access for the first download. No org credentials or live Salesforce writes are used.

The core test verifies a partial bulk sync, recovery on the next sync, an incremental no-op and offline status without a remote call. The installer tests cover preflight across all skills, existing files, dry-run, forced replacement, shared destinations, symlink rejection and legacy JSON compatibility. The tarball check installs from an extracted npm artifact without network or subprocess access. The pinned `skills` CLI checks all three skills for Claude Code, Codex, GitHub Copilot and Devin in isolated project roots.

## Synthetic investigation workspace

Committed inputs are JSON, never org log files. To create an empty temporary workspace populated with synthetic `.log` files and Apex source:

```bash
node scripts/agent-debug-fixtures.mjs /tmp/electivus-debug-example
```

The destination must be empty. It includes ignored log paths with spaces supported, sixty unrelated canonical logs, one other-org false positive, a legacy duplicate and a legacy-only asynchronous producer. The automated corpus test uses real ripgrep to find filenames before excerpts, scope by org, preserve physical line numbers and distinguish no matches (exit 1) from a search error (exit 2).

Use the prompts and expected findings in `test/agent-debug/corpus.json` for manual client evaluation. Tell the agent to work offline with the supplied corpus; request edits only in this disposable workspace. The snippets are deliberately small parser and reasoning fixtures, not deployable production Apex or a performance benchmark.

| Case               | Acceptance evidence                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional failure | Find ORDER-4821 in the intended org; distinguish the fatal null dereference from the caught exception; cite log and source lines; handle an absent optional discount without changing present-value semantics. |
| Caught exception   | Find the handled timeout and subsequent completion; do not claim transaction failure from `EXCEPTION_THROWN` or `triage.hasErrors` alone.                                                                      |
| Async and Flow     | Connect producer and consumer using the explicit job ID; report the Flow element and validation failure; do not infer identity or causality from timestamps alone.                                             |
| Governor limit     | Identify SOQL 101/100, distinguish it from CPU usage, inspect source before claiming a query-in-loop cause and propose a bulk-safe correction.                                                                 |
| Incomplete capture | Detect truncation and disabled database/profiling categories; do not treat missing events or zero counts as proof that no work occurred.                                                                       |
| Capture needed     | Explain the intended execution identity, trace target, TTL and required categories; preview authorized writes; retain cleanup responsibility for resources actually created or changed.                        |
| Verification       | Report which checks ran. For before/after claims, compare equivalent inputs and capture settings; an unexecuted reproduction remains pending.                                                                  |

## What each validation layer proves

| Layer                                | Scope                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated bundle and manifest checks | Reproducible artifacts, relative references, same configured analyzer across formats, no missing standalone resources.                                                     |
| Installer and package tests          | Actual installation paths, contents, selection and compatibility; no model judgment.                                                                                       |
| Core and corpus tests                | Sync/status contracts and real local-search behavior on controlled inputs.                                                                                                 |
| Official MCP integration             | Actual parser/tool behavior on the supplied synthetic cases, including execution refusal.                                                                                  |
| Native client validation/listing     | Manifest acceptance or plugin discovery in the tested client version.                                                                                                      |
| Manual client investigation          | Skill activation, tool selection, interpretation, correction quality and end-to-end result in that client. This is a separate evaluation, not implied by a valid manifest. |

VS Code UI activation and live-org capture require their own environment and evidence. No automated model sessions or live-org runs are part of these checks. Use the last two layers when assessing a new client release or changing behavioral instructions.

## Local client checks (2026-09-21)

Verified on Ubuntu/WSL with Node 24.21.0. These are manifest/discovery checks, not model-driven debugging sessions:

| Client / format                          | Version          | Observed result                                                                                                                                                                  |
| ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI                                | 0.156.0-alpha.14 | Lists `electivus-debug@electivus` version 0.1.0 from a local marketplace supplied through a command-local config override. The plugin-creator validator also accepts the bundle. |
| Claude Code                              | 2.1.278          | Accepts the plugin manifest and marketplace without errors or warnings.                                                                                                          |
| GitHub Copilot CLI                       | 1.0.87-0         | Discovers `electivus-debug` version 0.1.0 through `--plugin-dir`.                                                                                                                |
| Agent Plugins schemas                    | 1.0.0            | Both portable manifests pass the official JSON schemas.                                                                                                                          |
| GitHub Copilot in VS Code / Codex app UI | Not run          | UI loading and skill activation still need an interactive client check.                                                                                                          |

Repeat the native checks from the repository root:

```bash
claude plugin validate plugins/electivus-debug --strict --json
claude plugin validate .claude-plugin/marketplace.json --strict --json
copilot --plugin-dir ./plugins/electivus-debug plugin list --json
```

For Codex without installing a marketplace, replace `/absolute/repo` below with this checkout's absolute path. The override applies only to this command:

```bash
codex -c 'marketplaces.electivus={source_type="local",source="/absolute/repo"}' plugin list --marketplace electivus --available --json
```
