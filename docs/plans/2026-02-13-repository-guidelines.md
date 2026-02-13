# Repository Guidelines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a root `AGENTS.md` contributor guide for the monorepo that summarizes structure, commands, style, testing, and PR expectations in 200–400 words.

**Architecture:** A single Markdown document at repo root that references existing paths and scripts. Content is distilled from existing repo docs (`README.md`, `CONTRIBUTING.md`, `docs/TESTING.md`) to stay accurate and concise.

**Tech Stack:** Markdown; Node.js/npm and Rust/Cargo (for command examples).

---

### Task 1: Draft `AGENTS.md`

**Files:**
- Create: `AGENTS.md`

**Step 1: Write the failing test**

```bash
python - <<'PY'
from pathlib import Path
import re
path = Path('AGENTS.md')
assert path.exists(), 'AGENTS.md missing'
text = path.read_text()
assert text.startswith('# Repository Guidelines'), 'Title must be Repository Guidelines'
words = re.findall(r"\b\w+\b", text)
assert 200 <= len(words) <= 400, f'Word count {len(words)} not in 200-400'
PY
```

**Step 2: Run test to verify it fails**

Run:
```bash
python - <<'PY'
from pathlib import Path
import re
path = Path('AGENTS.md')
assert path.exists(), 'AGENTS.md missing'
text = path.read_text()
assert text.startswith('# Repository Guidelines'), 'Title must be Repository Guidelines'
words = re.findall(r"\b\w+\b", text)
assert 200 <= len(words) <= 400, f'Word count {len(words)} not in 200-400'
PY
```

Expected: FAIL with `AGENTS.md missing`.

**Step 3: Write minimal implementation**

```markdown
# Repository Guidelines

## Project Structure & Module Organization
- `apps/vscode-extension/` hosts the VS Code extension (TypeScript) and webview UI under `src/webview/`.
- `crates/cli/` contains the Rust CLI (`apex-log-viewer-cli`) with tests in `crates/cli/tests/`.
- `docs/` holds architecture/testing notes; `media/` stores bundled webview assets; `scripts/` contains tooling.

## Build, Test, and Development Commands
- `npm run ext:install` installs extension dependencies.
- `npm run ext:build` bundles the extension and webview.
- `npm run ext:watch` runs watchers; press `F5` in VS Code to launch the Extension Development Host.
- `npm run ext:test` runs lint, typecheck, Jest webview tests, and VS Code unit tests.
- `cargo build -p apex-log-viewer-cli` builds the Rust CLI.
- `cargo test -p apex-log-viewer-cli` runs CLI tests.

## Coding Style & Naming Conventions
- TypeScript strict mode, 2-space indent, semicolons; use `npm run lint` and `npm run format`.
- Components/classes use `PascalCase`; functions/vars use `camelCase`.
- File patterns: `apps/vscode-extension/src/webview/components/Name.tsx`, utilities in `apps/vscode-extension/src/utils/name.ts`.
- Rust follows standard `rustfmt` defaults.

## Testing Guidelines
- Webview tests use Jest in `apps/vscode-extension/src/webview/__tests__/` with `*.test.tsx`.
- Extension tests run in the VS Code host under `apps/vscode-extension/src/test/`.
- Coverage thresholds are enforced via `c8` (see `.c8rc.json`).

## Commit & Pull Request Guidelines
- Use Conventional Commits (for example `feat(logs): add filter`, `fix(tail): handle missing CLI`).
- PRs should include build/test results, update `CHANGELOG.md` for user-facing changes, and add screenshots/GIFs for UI updates.

## Security & Configuration Tips
- Use Node `22` via `.nvmrc`; Salesforce CLI (`sf`/`sfdx`) is required for runtime usage.
- Never commit tokens or org-sensitive data; keep logs under `apexlogs/`.
- `*.log` and `*.txt` are blocked by hooks/CI.

## Architecture Overview
- Extension host logic lives in `apps/vscode-extension/src/extension.ts` with services under `src/services/` and shared types in `src/shared/`.
- Webview bundles from `apps/vscode-extension/src/webview/` into `media/` and communicates via VS Code webview messaging.
- The CLI is a separate Rust binary in `crates/cli/` and is not required for the extension build.
```

**Step 4: Run test to verify it passes**

Run:
```bash
python - <<'PY'
from pathlib import Path
import re
path = Path('AGENTS.md')
assert path.exists(), 'AGENTS.md missing'
text = path.read_text()
assert text.startswith('# Repository Guidelines'), 'Title must be Repository Guidelines'
words = re.findall(r"\b\w+\b", text)
assert 200 <= len(words) <= 400, f'Word count {len(words)} not in 200-400'
PY
```

Expected: PASS (no output).

**Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add repository guidelines"
```
