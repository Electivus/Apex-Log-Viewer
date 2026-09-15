# Real-org E2E on Arch Linux / WSL2

Keep the checkout, dependencies, builds and IDE caches on the Linux filesystem. Use the existing dedicated Dev Hub JWT identity from [DEVHUB_LOCAL.md](DEVHUB_LOCAL.md); do not copy a Windows Salesforce home or substitute an authenticated host alias.

## Prepare the Linux runtime

Use Arch's system Node.js and the approved corporate CA already trusted by Arch. The local runtime must satisfy `package.json#engines`; `.nvmrc` remains the exact reference version for CI. From the repository:

```bash
sudo -n pacman -S --needed nodejs npm corepack
/usr/bin/node --version
/usr/bin/npm --version
export NODE_USE_SYSTEM_CA=1
install -d "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin" pnpm
corepack pnpm install --frozen-lockfile

INSTALL_LINUX_DEPS=true corepack pnpm run test:linux-deps
sudo -n pacman -S --needed jdk21-openjdk

export SALESFORCE_CLI_CACHE_ROOT="$HOME/.local/share/electivus/apex-log-viewer/salesforce-cli"
node scripts/setup-salesforce-cli.mjs
corepack pnpm run build
```

The CLI setup uses the repository's exact Salesforce CLI version and the system Node runtime. Corepack selects the project's pinned pnpm version. The Arch dependency installer uses existing synchronized package metadata with `--needed`; it never runs a partial `pacman -Sy` upgrade. This Electron-based suite uses the VS Code download supplied by the test harness and does not require installing a separate Playwright browser. After a system Node upgrade, rerun `node scripts/setup-salesforce-cli.mjs` to prepare the cache for that runtime version.

## Restore the existing operator state

The Linux destination is `~/.electivus/apex-log-viewer/devhub-jwt`. Restore an operator-verified Windows backup into this previously absent directory, following the restoration contract in [DEVHUB_LOCAL.md](DEVHUB_LOCAL.md#operator-state):

1. Check that the Windows journal has no operation lock or pending replacement. Verify the active certificate fingerprint and matching private key.
2. Copy the existing private tree, retaining an unchanged copy of the original journal and active inputs for audit. Keep all Linux directories at `0700` and files at `0600`; reject links and destinations inside Git, temporary storage or caches.
3. Translate only private path references in the restored journal and its active inputs to the copied Linux files. Preserve ownership, identity, lifecycle, timestamps, historical approvals and unavailable rollback evidence. Historical approval plans must not be rewritten or replayed to make their Windows paths appear native.
4. Compare source/copy hashes and confirm the Windows source was unchanged. Then run the fresh JWT verification below. A copy operation alone is not authentication proof.

This restores an existing journal; it does not create an identity, rotate a certificate, update GitHub Secrets or fabricate lost history. The operator-specific copy receipt and source backups belong inside private storage, never in this repository or test artifacts. Use one operator root for future credential lifecycle changes, then explicitly reconcile other verified copies; simultaneous Windows/WSL rotations are not coordinated by the local directory locks.

## Configure this operator

Create `~/.config/electivus/apex-log-viewer/e2e.sh` with mode `0600`. It contains only non-secret runtime settings:

```bash
export NODE_USE_SYSTEM_CA=1
export SALESFORCE_CLI_CACHE_ROOT="$HOME/.local/share/electivus/apex-log-viewer/salesforce-cli"
export JAVA_HOME_21_X64=/usr/lib/jvm/java-21-openjdk
export SF_SCRATCH_POOL_NAME='<existing configured pool>'
export PLAYWRIGHT_WORKERS=1
export PLAYWRIGHT_RETRIES=2
export PLAYWRIGHT_TIMEOUT_MS=360000
export PLAYWRIGHT_EXPECT_TIMEOUT_MS=60000
export SF_USE_GENERIC_UNIX_KEYCHAIN=true
```

Obtain the existing pool name from the operator runbook or `gh variable get SF_SCRATCH_POOL_NAME --repo Electivus/Apex-Log-Viewer`. Do not put JWT values or authorization URLs in the shell configuration. The launcher enforces pool use for normal real-org suites; controlled direct JWT smokes have their own explicit opt-ins.

In a WSL session without a desktop Secret Service, `secret-tool` can be installed but unusable. Salesforce CLI may report successful JWT login while failing to persist encrypted auth, followed by `NamedOrgNotFoundError` on the API query. The diagnostic log contains `SetCredentialError` and `secret-tool: The name is not activatable`. The supported `SF_USE_GENERIC_UNIX_KEYCHAIN=true` setting selects encrypted file storage within each private CLI home. JWT remains the authentication method.

For Salesforce CLI commands outside the E2E launcher, also persist `export SF_USE_GENERIC_UNIX_KEYCHAIN=true` in the operator's `~/.zshenv`. This makes the encrypted storage backend consistent across new Zsh sessions. Existing terminals need to load the setting or restart their shell. To reverse this user-wide setting, remove that export; retain the encrypted auth files and key. This setting alone does not authenticate the Dev Hub into the user's global CLI home.

### Corporate CA for IntelliJ test workers

The Gradle build uses Java 21, but IntelliJ tests can run with the IDE's downloaded JetBrains Runtime. Its bundled `cacerts` may lack the corporate root even when Node, curl and the system JDK work.

Create a separate operator truststore from that runtime's original `cacerts`, then import the **already approved system CA**. For example, after locating the selected IDE runtime under the Gradle cache:

```bash
jbr_cacerts='<selected JetBrains Runtime>/lib/security/cacerts'
e2e_truststore="$HOME/.config/electivus/apex-log-viewer/java-cacerts.jks"
corporate_ca='/etc/ca-certificates/trust-source/anchors/corporate-root-ca.crt'

# Refuse to overwrite an existing operator truststore; retain a backup before updating it.
test ! -e "$e2e_truststore"
install -m 600 "$jbr_cacerts" "$e2e_truststore"
/usr/lib/jvm/java-21-openjdk/bin/keytool -importcert -noprompt \
  -alias alv-arch-corporate-root-ca -file "$corporate_ca" \
  -keystore "$e2e_truststore" -storepass changeit
```

Here `changeit` is the standard password of the public certificate truststore, not an application credential. Confirm that every original runtime certificate remains present and only the approved CA was added. Append this setting to the operator's `e2e.sh`, preserving any existing JVM options:

```bash
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djavax.net.ssl.trustStore=$HOME/.config/electivus/apex-log-viewer/java-cacerts.jks"
```

This applies the truststore to Gradle and its forked IDE test workers. It does not disable TLS verification or modify downloaded IDE installations. Rebuild the operator truststore deliberately when the runtime's root set or corporate CA changes. To reverse the override, remove this setting from `e2e.sh`; retain the original runtime and system truststores.

## Run tests

Once the private operator state and `e2e.sh` above are configured, the normal package commands load the local environment automatically:

```bash
npm run test:e2e
npm run test:e2e:cli

# Pass a file filter or other Playwright arguments after npm's separator.
npm run test:e2e -- test/e2e/specs/openLogViewer.e2e.spec.ts
```

Creating the operator's `e2e.sh` opts this Linux machine into automatic setup. The runners start the existing JWT wrapper, which validates the durable journal, certificate, fresh login and User API before exposing inputs to the child. The child resumes the runner directly, so bootstrap does not repeat the npm build hook or recursively invoke the package command. The private key remains in durable storage and the current journal is read on each execution, including after rotation.

CI, Windows/macOS, explicit credential inputs (including incomplete JWT or legacy auth selections), custom Playwright configs, and help/list invocations retain their existing setup behavior. Explicit inputs are not replaced with the operator's identity. Remove or rename the local `e2e.sh` to disable automatic setup; do not remove the durable JWT root. This automatic path covers UI and CLI E2E; telemetry and Docker proxy-lab still use their documented explicit setup.

The launcher is also available for verification, explicit execution and the optional IntelliJ lane:

```bash
bash scripts/run-wsl-e2e.sh verify
bash scripts/run-wsl-e2e.sh cli
bash scripts/run-wsl-e2e.sh ui
bash scripts/run-wsl-e2e.sh intellij

# Restrict a UI run or pass other normal Playwright arguments.
bash scripts/run-wsl-e2e.sh ui test/e2e/specs/openLogViewer.e2e.spec.ts
```

The launcher selects `/usr/bin/node`, loads the non-secret configuration, selects the pinned Linux Salesforce CLI and verifies JWT before starting the child. Automatically configured UI runs and the explicit `ui` command use their own Xvfb display, independent of WSLg and open editor windows. CLI runs do not launch Xvfb. Test subprocesses do not inherit `PLAYWRIGHT_MCP_CDP_ENDPOINT`. Exit codes are preserved. `bash scripts/run-wsl-e2e.sh run -- <command> [args]` applies the same settings and verified JWT inputs to an explicit command.

For a cold IntelliJ checkout, prepare the test classes before consuming a scratch lease:

```bash
JAVA_HOME=/usr/lib/jvm/java-21-openjdk bash -c \
  'cd apps/intellij-plugin && ./gradlew --no-daemon testClasses'
```

For the optional JavaScript/TypeScript JWT lifecycle smokes, provide `ALV_DEVHUB_JWT_SMOKE=1` and the operator-verified `ALV_JWT_SMOKE_DEVHUB_ORG_ID` as described in [DEVHUB_JWT.md](DEVHUB_JWT.md#controlled-smoke-and-observed-results). These tests create and delete their own scratches. The isolated administrative pool smoke is a separate opt-in.

Telemetry is a separate Azure-authenticated lane: `bash scripts/run-wsl-e2e.sh telemetry` additionally requires a usable `az` CLI login and the explicit telemetry target variables from [TESTING.md](TESTING.md). A working Salesforce JWT does not migrate an Azure login. The normal CLI/UI/IntelliJ suites above do not require Azure CLI. The Docker proxy-lab also remains a separate execution environment with its own image and CA setup.

Keep diagnostic logs under `apexlogs/` and inspect the Playwright results, actual scratch operations and cleanup. Preserve any specifically reported recovery directory until its owned scratch is recovered. Normal test cleanup must not remove either durable operator root.
