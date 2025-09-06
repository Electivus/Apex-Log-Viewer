# Telemetry

This extension uses the official `@vscode/extension-telemetry` module to emit minimal, anonymized usage and error telemetry. Telemetry helps us prioritize features and improve reliability.

What we collect

- Activation and command usage counts (e.g. `command.refresh`, `command.tail`).
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

- No secrets are committed. The telemetry connection string must be provided via environment variable during packaging/publish and injected temporarily into the VSIX metadata:
  - Environment variable `APPLICATIONINSIGHTS_CONNECTION_STRING` (preferred) or `VSCODE_TELEMETRY_CONNECTION_STRING`.
  - Our CI writes this value to `package.json.telemetryConnectionString` just before packaging, and removes it afterwards.
- If no connection string is provided, telemetry is a no‑op.
- When adding events, avoid PII. Prefer counts, booleans, and coarse buckets. Never include usernames, org IDs, file paths, or log content.

GitHub Actions integration

- Adicione uma variável de repositório (Actions → Variables) chamada `APPLICATIONINSIGHTS_CONNECTION_STRING` contendo sua Application Insights connection string (não sensível segundo a documentação da Microsoft).
- Exporte-a como variável de ambiente no workflow antes do empacotamento. Os scripts irão injetá-la em `package.json` durante o empacotamento e removê-la depois.

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
      - name: Ensure telemetry variable present
        env:
          APPLICATIONINSIGHTS_CONNECTION_STRING: ${{ vars.APPLICATIONINSIGHTS_CONNECTION_STRING }}
        run: |
          if [ -z "${APPLICATIONINSIGHTS_CONNECTION_STRING:-}" ]; then
            echo "Missing APPLICATIONINSIGHTS_CONNECTION_STRING variable. Refusing to package without telemetry." >&2
            exit 1
          fi

      - name: Package VSIX
        run: npm run vsce:package
        env:
          APPLICATIONINSIGHTS_CONNECTION_STRING: ${{ vars.APPLICATIONINSIGHTS_CONNECTION_STRING }}
      # Optionally upload the VSIX artifact here
```


References

- VS Code telemetry overview: https://code.visualstudio.com/docs/configure/telemetry
- Telemetry guide for extensions: https://code.visualstudio.com/api/extension-guides/telemetry
