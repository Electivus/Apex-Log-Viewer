# Assets & Screenshots

This repository keeps README and Marketplace screenshots under `apps/vscode-extension/media/docs/`, so they are packaged with the extension and the walkthrough can reference them.

## Current Docs Assets

- `hero.png` — primary README/Marketplace hero of the `Apex Logs` panel, focused on search, match snippets, triage badges, and the org picker.
- `log-viewer.png` — dedicated `Apex Log Viewer` with the failure banner, the failed entry selected, and the diagnostics sidebar. The `Get started with Apex Logs` walkthrough also shows it.
- `debug-flags.png` — `Apex Debug Flags` editor with user search, TTL/apply/remove controls, and the Debug Level Manager. The walkthrough also shows it.
- `tail.png` — `Apex Tail` panel with live log lines.
- `custom-logs.png` — `Custom Logs` panel with JSON payload columns and a search over the loaded rows.

## Regenerating Screenshots

Use the manual docs flow:

```bash
pnpm run docs:screenshots
```

What it does:

- reuses the Playwright + Electron harness already used by E2E coverage
- prepares a realistic scratch-org scenario with deterministic Apex logs
- maps a Custom Logs source over `Account` in the temporary workspace and seeds its rows, because a harness scratch has no Nebula Logger, then deletes those rows
- refreshes and saves log bodies into the temporary workspace so README search screenshots use the real local-search flow before any optional bulk download step
- writes the final PNGs directly into `apps/vscode-extension/media/docs/`

This flow is intentionally separate from `pnpm test` and `pnpm run test:e2e` so README maintenance does not run in the default CI path.

Org selection works as for `pnpm run test:e2e`. Run it locally with `SF_DEVHUB_ALIAS` and no pool variables, so it uses the single scratch `ALV_E2E_Scratch`. See [Run locally](TESTING.md#run-locally).

## Conventions

- Prefer PNG for documentation screenshots.
- Keep width around the 1200–1800px range before compression.
- Show harness scratch data only. Avoid exposing real customer data, tokens, or org-sensitive identifiers.
- `README.md` links the images with `raw.githubusercontent.com` URLs under `apps/vscode-extension/media/docs/`, so the Marketplace can show them.
- The packaged file allowlist in `apps/vscode-extension/package.json#files` must include `media/docs/**`.

## Notes

- Raw captures and temporary workspaces should stay out of the repository.
