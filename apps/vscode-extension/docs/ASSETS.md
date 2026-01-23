# Assets & Screenshots

This project packages screenshots with the extension so they render on both GitHub and the VS Code Marketplace.

- Folder: put screenshots under `media/docs/`.
- Naming: use short, descriptive names:
  - `hero.gif` — short overview animation (5–12s)
  - `log-list.png` — main table view
  - `filters.png` — filters/search
  - `replay.png` — Apex Replay action
  - `tail.png` — tail logs panel
  - `select-org.png` — org switcher
  - `settings.png` — settings panel
- Format:
  - PNG for stills (1200–1600px width).
  - GIF for short loops (max ~8–10 MB).
  - Use `pngquant`/`gifski` or export with compression to keep size reasonable.
- Referencing: use relative Markdown links in `README.md`, e.g. `![Log list](media/docs/log-list.png)`.
- Packaging: assets included in the `.vsix` are defined in `package.json#files`.

Notes

- Keep raw captures or project files out of the repo. Add only optimized assets.
- If you need to exclude heavy sources, add them to `.gitignore` (but keep `media/docs/*.png|gif`). The VSIX contents are controlled by the allowlist in `package.json#files`. Avoid adding a `.vscodeignore` file because `vsce` does not allow using both `.vscodeignore` and `package.json#files` simultaneously.
