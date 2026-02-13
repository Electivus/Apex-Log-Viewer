# AGENTS.md Contributor Guide Design

## Context
The repository is a monorepo with two primary deliverables:
- VS Code extension under `apps/vscode-extension/` (TypeScript + React webview).
- Rust CLI under `crates/cli/`.

There is no current root-level `AGENTS.md`, and contributors need a concise, repo-specific guide that covers both subprojects equally.

## Goals
- Produce a 200–400 word `AGENTS.md` titled "Repository Guidelines".
- Cover project structure, build/test/dev commands, coding style, testing, commits/PRs, security/sensitive-file rules, and a short architecture overview.
- Keep guidance actionable and grounded in existing repo docs (`README.md`, `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`, `package.json`).

## Non-goals
- No deep onboarding or release process documentation (already in `CONTRIBUTING.md`).
- No step-by-step CLI usage examples beyond build/test commands.

## Proposed Content Structure
1. **Repository Guidelines** (H1)
2. **Project Structure & Module Organization**
   - `apps/vscode-extension/`, `crates/cli/`, `docs/`, `media/`, `scripts/`.
   - Tests under `apps/vscode-extension/src/test` and `apps/vscode-extension/src/webview/__tests__`, plus `crates/cli/tests`.
3. **Build, Test, and Development Commands**
   - Root `npm run ext:*` commands for extension.
   - Rust `cargo build/test -p apex-log-viewer-cli`.
   - Note watch mode + VS Code F5 for extension.
4. **Coding Style & Naming Conventions**
   - TypeScript: 2-space indent, semicolons, ESLint + Prettier, PascalCase components, camelCase functions/vars, file naming patterns.
   - Rust: standard rustfmt defaults, tests under `crates/cli/tests`.
5. **Testing Guidelines**
   - Jest for webview, Mocha/@vscode/test-electron for extension integration; naming `*.test.ts`/`*.test.tsx` and `__tests__`.
   - CLI tests via `cargo test` and files in `crates/cli/tests`.
6. **Commit & Pull Request Guidelines**
   - Conventional Commits types and scoped format; align PR titles.
   - PR checklist items from `CONTRIBUTING.md` (build/test, changelog, screenshots for UI, verification notes).
7. **Security & Configuration Tips**
   - Use `.nvmrc` (Node 22), Salesforce CLI auth, avoid tokens in logs.
   - Do not commit `*.log`/`*.txt`; keep logs under `apexlogs/`.
8. **Architecture Overview**
   - Extension host + webview UI with shared types in `src/shared`.
   - CLI as a separate Rust binary.

## Data Flow / Dependencies
- Extension host communicates with the webview via VS Code webview messaging.
- CLI is independent, built via Cargo, not required for extension build.

## Error Handling & Edge Cases
- Keep guidance specific and avoid claiming commands that do not exist.
- Emphasize where to look (`docs/TESTING.md`, `docs/ARCHITECTURE.md`) rather than duplicating full details.

## Testing/Verification
- No code tests required; verify by ensuring the document is within 200–400 words and references valid paths/commands.

## Rollout
- Add `AGENTS.md` at repo root.
