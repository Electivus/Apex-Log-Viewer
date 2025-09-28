# Telemetry

This extension uses the official `@vscode/extension-telemetry` module to emit minimal, anonymized usage and error telemetry. Telemetry helps us prioritize features and improve reliability.

What we collect

- Activation and command usage counts (e.g. `command.refresh`, `command.tail`).
- Coarse performance timings (e.g., activation duration, log refresh time).
- Coarse environment info (platform, VS Code version) to understand compatibility.
- Non‑PII error categories (e.g. error names like `ETIMEDOUT`, not full messages or stacks).

What we do not collect

- No source code, Apex log contents, access tokens, usernames, org IDs, or instance URLs.
- No full error messages or stack traces that could contain PII.

Respecting user settings and modes

- VS Code’s `telemetry.telemetryLevel` controls whether telemetry is sent (`off`, `crash`, `error`, `all`). When `off`, nothing is sent.
- Telemetry is automatically disabled when the extension runs in Development or Test mode (Extension Development Host and tests).
- The reporter respects the VS Code setting automatically; no additional configuration is required by users.

Opt‑out

- Set `"telemetry.telemetryLevel": "off"` in your VS Code settings to disable telemetry globally.

For maintainers

- The connection string is checked in with the extension (we surface it via `package.json.telemetryConnectionString`). No CI-time injection is required anymore; the bundler simply reads the value during activation.
- If the field is left empty, telemetry becomes a no-op automatically.
- When adding events, avoid PII. Prefer counts, booleans, and coarse buckets. Never include usernames, org IDs, file paths, or log content.

GitHub Actions integration

- Workflows can package or publish the VSIX without providing any telemetry environment variables.
- Optional: if you need to override the baked-in connection string for an experiment, set `APPLICATIONINSIGHTS_CONNECTION_STRING` or `VSCODE_TELEMETRY_CONNECTION_STRING` in the job environment; the runtime still prefers that when present.

Example job snippet:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Build (extension + webview)
        run: npm run package
      - name: Package VSIX
        run: npx --yes @vscode/vsce package
      # Optionally upload the VSIX artifact here
```


References

- VS Code telemetry overview: https://code.visualstudio.com/docs/configure/telemetry
- Telemetry guide for extensions: https://code.visualstudio.com/api/extension-guides/telemetry
