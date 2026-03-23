# Assets & Screenshots

This repository keeps README and Marketplace screenshots under `media/docs/` so they can be referenced with relative Markdown paths and packaged with the extension.

## Current Docs Assets

- `hero.png` — primary README/Marketplace hero focused on search, snippets, triage badges, org selector, and the refresh-first local-search workflow.
- `log-viewer.png` — dedicated `Apex Log Viewer` with diagnostics sidebar visible.
- `debug-flags.png` — `Apex Debug Flags` editor with user search, TTL/apply/remove controls, and the Debug Level Manager.
- `tail.png` — real-time tail view with live log lines.

## Regenerating Screenshots

Use the manual docs flow:

```bash
npm run docs:screenshots
```

What it does:

- reuses the Playwright + Electron harness already used by E2E coverage
- prepares a realistic scratch-org scenario with deterministic Apex logs
- refreshes and saves log bodies into the temporary workspace so README search screenshots use the real local-search flow before any optional bulk download step
- writes the final PNGs directly into `media/docs/`

This flow is intentionally separate from `npm test` and `npm run test:e2e` so README maintenance does not run in the default CI path.

## Conventions

- Prefer PNG for documentation screenshots.
- Keep width around the 1200–1800px range before compression.
- Avoid exposing real customer data, tokens, or org-sensitive identifiers.
- Relative paths in `README.md` should point to `media/docs/*.png`.
- The packaged file allowlist in `package.json#files` must include `media/docs/**`.

## Notes

- Raw captures and temporary workspaces should stay out of the repository.
- Old GIFs can remain for reference while the docs transition, but new README assets should use the static PNG set above.
