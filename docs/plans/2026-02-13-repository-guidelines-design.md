# Repository Guidelines Design

## Context
The repository is a monorepo with two primary deliverables:
- VS Code extension under `apps/vscode-extension/` (TypeScript + React webview).
- Rust CLI under `crates/cli/`.

The user requested a concise root-level `AGENTS.md` titled "Repository Guidelines" with a 200–400 word contributor guide.

## Goals
- Produce a clear, repo-specific contributor guide in Markdown at `AGENTS.md`.
- Cover project structure, build/test/dev commands, coding style, testing, and commit/PR guidance.
- Include short examples and pointers to authoritative docs without duplicating them.

## Non-goals
- No full onboarding, release, or deep architecture documentation.
- No new workflows or commands not present in the repo.

## Proposed Content
1. **Repository Guidelines (H1)**
2. **Project Structure & Module Organization**
   - `apps/vscode-extension/`, `crates/cli/`, `docs/`, `media/`, `scripts/`.
3. **Build, Test, and Development Commands**
   - Root `npm run ext:*` wrappers and extension-local `npm run build/watch/test`.
   - CLI `cargo build/test -p apex-log-viewer-cli`.
4. **Coding Style & Naming Conventions**
   - TypeScript: 2-space indent, semicolons, ESLint/Prettier.
   - Naming: PascalCase components, camelCase functions.
   - Rust: default `rustfmt` conventions.
5. **Testing Guidelines**
   - Jest for webview; Mocha/@vscode/test-electron for extension.
   - CLI tests via `cargo test`, in `crates/cli/tests`.
6. **Commit & Pull Request Guidelines**
   - Conventional Commits and PR checklist highlights.
7. **Security & Configuration Tips**
   - `.nvmrc`, Salesforce CLI auth, no sensitive logs/tokens in commits.

## References
- `README.md`, `CONTRIBUTING.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`, `package.json`.

## Verification
- Ensure final `AGENTS.md` is 200–400 words and only references valid paths/commands.
