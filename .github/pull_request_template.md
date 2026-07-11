# Pull Request Template

## Conventional Commit Title
- Use a Conventional Commit in the PR title, e.g. `feat: add head concurrency setting` or `fix(provider): handle null logs`.

## Summary
- What changed and why? Keep it brief and specific.

## Linked Issues
- Closes #<id>, Relates-to #<id>

## Screenshots / GIFs (UI)
- Attach visuals for webview changes when helpful.

## Verification Steps
- Commands used (e.g., `pnpm run build`, `pnpm test`).
- Manual steps to validate (debug via VS Code `F5`).
- For integration tests, ensure Salesforce extension is available and an org is authenticated (`sf org login web`).

## Risk / Rollback
- Risks introduced and how to revert safely.

## Checklist
- [ ] `pnpm run build` passes
- [ ] `pnpm test` (or `pnpm run test:all`) passes; integration tests prefixed with `integration`
- [ ] Lint/Types: `pnpm run lint` and `pnpm run check-types`
- [ ] Docs updated (AGENTS.md/README snippets if applicable)
- [ ] No secrets or org-sensitive data added

