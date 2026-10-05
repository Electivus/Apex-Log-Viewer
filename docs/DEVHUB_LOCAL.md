# Durable local Dev Hub JWT validation

Local automated real-org tests and pool operations use the same dedicated JWT identity as CI. A host Dev Hub alias, cached account or legacy authorization URL cannot replace missing or invalid JWT. Unit-only tests continue to run without Salesforce credentials.

## Operator state

The default directory is `%USERPROFILE%\.electivus\apex-log-viewer\devhub-jwt` on Windows, or `~/.electivus/apex-log-viewer/devhub-jwt` on Linux/macOS. Keep the active key, certificate, `identity.json`, and its `inputsFile` reference together under this private root. Absolute references must resolve inside it. Do not create a journal by hand: use the identity lifecycle commands or the explicitly approved lost-material recovery procedure.

The path must be outside Git checkouts, temporary and synchronized folders, links/junctions and application caches. Windows packaged applications can redirect an apparently ordinary `AppData\Local` path into `Packages\...\LocalCache`; the commands reject redirected paths. Windows permissions allow only the current user and SYSTEM. Unix directories use mode 0700 and operator input files must use 0600. Do not share or archive this tree as a CI artifact: retrieved ECA metadata may also contain a consumer secret.

An existing valid journal can be restored from an operator-verified backup into durable storage. Preserve its ownership and history; update only its private path references to the verified copied files. Validate the key/certificate fingerprint and approved inputs before use. A missing or unreadable journal, key mismatch or pending rotation blocks validation. GitHub Actions Secret inventory exposes names/timestamps only and cannot recover an old key. When the original material is unavailable, follow [lost-material recovery](DEVHUB_ROTATION.md#lost-local-key-or-journal).

## Daily Windows workflow

Use Node 24, pnpm 11.11.0 through the existing Corepack setup and the repository-pinned Salesforce CLI. Retain approved corporate proxy and CA trust settings.

```powershell
# Fresh JWT confirms the Dev Hub; a User API query confirms the dedicated identity.
node scripts/devhub-local.js verify
if ($LASTEXITCODE -ne 0) { throw 'Repair JWT inputs before real-org tests.' }

# The wrapper verifies JWT and passes inputs only to this child process.
$env:SF_SETUP_SCRATCH = '1'
node scripts/devhub-local.js run -- node scripts/run-tests.js --scope=integration --vscode=stable

# Existing real-org entry points use the same operator inputs.
node scripts/devhub-local.js run -- corepack pnpm run test:e2e:cli
node scripts/devhub-local.js run -- corepack pnpm run scratch-pool:list -- --pool-key '<configured pool>' --json
```

Use `--state-dir '<absolute private directory>'` before `--` to select another verified durable root. The wrapper does not install persistent credential environment variables. Child exit status is preserved. It validates the recorded org and dedicated user before starting the child; a valid RSA key alone is not sufficient proof.

The minimum Salesforce Integration profile rejects Dev Hub SOQL on `Organization`. As in the [native identity proof](DEVHUB_IDENTITY.md#independent-native-proof), verification checks the org ID returned by fresh JWT login and the globally unique dedicated user ID through the runtime API. It does not add administrative permissions to run that query.

Every JWT session, including a file-based key, copies the key into its own empty CLI home. Renewal uses that session's private copy. Normal success/failure cleanup removes only workflow-owned state, leaving the durable original and journal intact for the next run. Pending scratch recovery retains its execution's credentials and reports its directory. Preserve that reported state until the owned scratch is recovered; do not delete the operator root or retry a denied removal through another mechanism.

For a complete lifecycle smoke, supply the existing opt-ins and verified Dev Hub ID from [DEVHUB_JWT.md](DEVHUB_JWT.md#controlled-smoke-and-observed-results), then run the smoke through this wrapper. It creates/deletes the authorized test scratches; `verify` alone does not prove scratch signup/import, pool leasing, UI behavior, telemetry ingestion or a passing CI workflow.

## Daily macOS workflow

Create `~/.config/electivus/apex-log-viewer/e2e-macos.sh` (mode `0600`) to opt this Mac into automatic JWT setup. Keep only non-secret runtime settings there. Select Node from `.nvmrc` and install the isolated CLI once:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
export SALESFORCE_CLI_CACHE_ROOT="$HOME/.local/share/electivus/apex-log-viewer/salesforce-cli"
export RUNNER_TEMP="$HOME/.local/share/electivus/apex-log-viewer/runtime"
SALESFORCE_CLI_WRAP_NODE=1 node scripts/setup-salesforce-cli.mjs
```

Point `ALV_SF_BIN_PATH` directly to the generated executable `alv-sf-node/sf` file. The launcher rejects the cache's ordinary `bin/sf`, relative paths and symlinks before JWT verification.

Example operator configuration (adjust the Node version when `.nvmrc` changes):

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
export ALV_SF_BIN_PATH="$HOME/.local/share/electivus/apex-log-viewer/runtime/alv-sf-node/sf"
export VSCODE_TEST_VERSION=stable
export SF_SCRATCH_STRATEGY=pool
export SF_SCRATCH_POOL_NAME='<configured pool>'
export PLAYWRIGHT_WORKERS=1
```

Keep the operator's existing keychain backend consistent. Do not switch backends or move encrypted auth files merely to enable this launcher. A local single-scratch run can instead set `SF_SCRATCH_STRATEGY=single`, choose its own `SF_SCRATCH_ALIAS`, omit the pool name and set `SF_TEST_KEEP_ORG=0` to delete its scratch afterward.

```bash
bash scripts/run-macos-e2e.sh verify
npm run test:e2e
npm run test:e2e:cli
```

The package commands load the configuration, verify the durable identity with a fresh JWT login, then start the requested runner. Credentials are passed only to child processes; the interactive shell receives no JWT secrets. UI runs use native macOS Electron, with the operator's browser endpoint removed. CI, explicit credential inputs, custom Playwright configs and help/list commands retain their existing behavior. Remove or rename `e2e-macos.sh` to disable automatic setup while retaining the durable credentials. The repository launcher runs in the current checkout; it does not depend on a user-wide `npm` alias or shell wrapper.

## WSL and containers

For native Arch Linux / WSL2 dependencies, restoration from Windows, encrypted CLI state, corporate Java trust and daily test commands, see [Real-org E2E on Arch Linux / WSL2](E2E_ARCH_WSL.md). Once its operator configuration is installed, `npm run test:e2e` and `npm run test:e2e:cli` load the verified local JWT automatically without exporting credential variables in the interactive shell. CI and explicit JWT inputs continue to use their existing setup.

The [proxy-lab runner](DEVHUB_JWT.md#transport-lifetime-and-recovery) validates the same JWT inputs, transports only copied private inputs through a read-only mount, and owns a separate credential volume for that execution. For example:

```powershell
node scripts/devhub-local.js run -- corepack pnpm run test:e2e:proxy-lab -- corepack pnpm run test:e2e:cli
```

Keep secrets out of Docker build contexts, image layers, command arguments, shell tracing, logs and output artifacts. Do not mount a developer's whole Salesforce home or the whole durable operator directory. If the engine cannot access a host path, resolve the supported scoped transport for that engine; do not fall back to an authenticated alias. Linux copies must remain private and survive until the dependent test/scratch cleanup completes. Removing a test's container/volume must never remove the durable Windows source.

Administrator bootstrap remains a separate, explicitly authorized metadata/permission operation. PlatformCLI still creates scratches and supplies exportable scratch authorization. Neither is a Dev Hub runtime fallback.
