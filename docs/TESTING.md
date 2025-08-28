# Integration tests: scratch org setup

To avoid activation errors from Salesforce extensions during tests, the test runner can authenticate a Dev Hub and create a default scratch org automatically using environment variables. This runs before the VS Code test host launches and sets the created scratch org as the default.

Environment variables

- `SF_DEVHUB_AUTH_URL`: SFDX auth URL for your Dev Hub (works with `sf` or `sfdx`).
- `SF_DEVHUB_ALIAS` (optional): Dev Hub alias; default `DevHub`.
- `SF_SCRATCH_ALIAS` (optional): Scratch org alias; default `ALV_Test_Scratch`.
- `SF_SCRATCH_DURATION` (optional): Scratch org duration (days); default `1`.
- `SF_SETUP_SCRATCH` (optional): Set to `1`/`true` to force scratch setup even without an auth URL.
- `SF_TEST_KEEP_ORG` (optional): Set to `1`/`true` to skip deleting the scratch org after tests.

Example

```
export SF_DEVHUB_AUTH_URL="<paste your SFDX auth URL>"
export SF_DEVHUB_ALIAS=DevHub
export SF_SCRATCH_ALIAS=ALV_Test_Scratch
npm test
```

Notes

- If `sf` is not found, the runner falls back to `sfdx` for compatible commands.
- If neither is present, the test runner attempts to `npm install` a local `@salesforce/cli` and adds `node_modules/.bin` to `PATH` for the session.

