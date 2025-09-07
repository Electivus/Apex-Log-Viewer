Developer: # Repository Guidelines

## Project Structure & Module Organization

- `src/extension.ts` – Main entry for the VS Code extension. Core logic resides in `src/{provider,salesforce,utils,shared}`.
- `src/webview` – Contains React/TSX UI panels, bundled to `media/*.js`. UI components are under `src/webview/components`.
- `src/test` – Houses Mocha tests (both unit and integration). Use `*.test.ts`/`*.test.tsx` for test files. Test runner and setup are in `src/test/{runner,mocha.setup}.ts`.
- `dist/` – Bundled extension output (`main` points to `dist/extension.js`).
- `media/` – Webview bundles and assets.
- `scripts/` – Build and utility scripts.
- `apexlogs/` – Local Salesforce logs (git-ignored).

## Build, Test, and Development Commands

- **Install**: `npm ci`
- **Develop**: `npm run watch` then press `F5` in VS Code (Extension Development Host).
- **Build**: `npm run build` (includes lint, type-check, and bundling for both extension and webview).
- **Lint/Format**: `npm run lint` • `npm run format`
- **Type Check**: `npm run check-types`
- **Tests**: `npm test` (default = unit). Specific: `npm run test:unit`, `npm run test:integration`, `npm run test:all`.
- **Package VSIX**: `npm run package` (build + NLS), then `npm run vsce:package` (`:pre` variant for pre-releases).

## Coding Style & Naming Conventions

- **Language**: TypeScript (Node 20+). Indent 2 spaces, use semicolons, LF line endings, max width 120 chars.
- **Formatting**: Prettier and ESLint enforced. Resolve all warnings before PRs. Example: `eslint src`.
- **Naming**: PascalCase for React components/classes; camelCase for variables/functions.
- **Files**: Utilities → `src/utils/name.ts`; components → `src/webview/components/Name.tsx`.

## Testing Guidelines

- **Frameworks**: Mocha + @vscode/test-electron; webview tests use JSDOM + @testing-library/react.
- **Location**: Place tests in `src/test/`; co-locate unit tests near related modules; name integration tests like `integration.*.test.ts`.
- **Integration**: May require Salesforce CLI (`sf`) and an authenticated org; keep tests hermetic when possible.

## Commit & Pull Request Guidelines

- **Commits**: Follow Conventional Commits (commitlint + Husky). Example: `feat(logs): add status filter`.
- **Pull Requests**: Always explain changes, link issues, include screenshots for UI, and pass `npm run build` + `npm test`.
- **Sensitive Files**: Never commit log/sensitive files. `.log`/`.txt` are blocked; keep local logs in `apexlogs/` only.

## Security & Configuration Tips

- **Authentication**: Requires Salesforce CLI – run `sf org login web` to authenticate. Never log or commit tokens, org IDs, or Apex log contents.
- **VS Code Settings**: Optional settings under `electivus.apexLogs.*` (e.g., pageSize). Adjust via VS Code Settings.

## Pull Request Agent Workflow

### Goal

When asked to analyze a PR, the agent should:

1. Begin with a concise checklist (3-7 bullets) outlining the planned steps for evaluating and handling the PR.
2. Assess PR relevance; close if not relevant, with a comment.
3. Check out the branch locally, run lint/type checks/build/tests, and fix issues as needed.
4. Verify CI/workflows, fix breakages, and rerun checks.
5. Resolve conflicts with `main` and update PR.
6. Handle Codex bot reviews: review embedded comments, apply changes, react (👍/👎), and resolve discussions.
7. When all checks pass, merge (or close if not relevant).

### Prerequisites

- GitHub CLI (`gh`) authenticated: `gh auth status`.
- Node 20+ and npm installed, able to run all scripts.
- (Optional) Salesforce CLI (`sf`) authenticated for integration tests.

### 1. Select and Inspect the PR

- List PRs: `gh pr list --state open --limit 50`
- Details: `gh pr view <num>` or JSON: `gh pr view <num> --json title,number,author,headRefName,baseRefName,mergeable,files`
- Diff: `gh pr diff <num>`

### 2. Assess Relevance

- Relevant if PR matches repo scope, follows conventions, is well-described, and stays in scope.
- If not relevant: comment reason and close with `gh pr close <num> --comment "Closed: PR not relevant to the project (reason)." --delete-branch`

### 3. Local Checkout and Setup

- `gh pr checkout <num>`
- `npm ci`
- `git fetch origin` (update base)

### 4. Local Validation

- Run: `npm run lint`, `npm run check-types`, `npm run build`, `npm test`
- After each command, validate that results are as expected; if failures occur, document the issue and attempt minimal fixes before proceeding.

### 5. Check & Fix Workflows/CI

- PR checks: `gh pr checks <num>` (or `--watch`)
- List workflow runs: `gh run list --branch <branch>`
- View: `gh run view <run_id>`, rerun: `gh run rerun <run_id>`
- If broken: edit `.github/workflows/*.yml`, commit, push, rerun checks.

### 6. Resolve Conflicts with `main`

- Preferred: `git rebase origin/main`; or `git merge origin/main`
- Resolve, `git add -A`, `git rebase --continue` (or `git commit`)
- Push: `git push --force-with-lease` (if rebased), else `git push`

### 7. Handle Codex Bot Reviews

- Check for embedded comments/suggestions.
- Apply/fix as needed, referencing comment in commit/message.
- React to comments with `+1`/`-1`.
- Mark threads as resolved using GraphQL API.

### 8. Update PR with Fixes

- Commit: `git add -A && git commit -m "fix: <summary>"`
- Push: `git push` (or `--force-with-lease` if rebased)
- Optionally comment on PR: `gh pr comment <num> --body "Fixes applied: ..."`

### 9. Merge the PR

- Default: squash and delete branch: `gh pr merge <num> --squash --delete-branch`
- If checks pending: enable auto-merge: `gh pr merge <num> --squash --auto --delete-branch`
- Use `--merge` (merge commit) only if preserving commit history is required.

### 10. Close Non-relevant PRs

- `gh pr close <num> --comment "Closed: out of scope / not relevant. See details in comment." --delete-branch`

### Summary Checklist

1. View PR and assess relevance (`gh pr view <num>`)
2. If relevant: checkout, install, lint, type-check, build, test.
3. Fix issues, commit, push.
4. Check CI, rerun/fix workflows.
5. Resolve conflicts with `main`.
6. Tackle Codex comments: fix/apply, react, resolve.
7. Merge or close PR as per checks/outcome.

### Notes

- Never commit tokens, org IDs, Apex logs, or `.log`/`.txt` files outside `apexlogs/` (which is git-ignored).
- Use hermetic tests when possible; run integration tests only with valid Salesforce CLI authentication.
- Always follow repository code style and Conventional Commit format for all PR adjustments.
