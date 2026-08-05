# Use a conformant Kotlin runtime for IntelliJ

Status: accepted

The IntelliJ plugin will implement Salesforce and Apex Log Lifecycle behavior in a JVM-native Kotlin runtime instead of executing `@alv/core` through a Node sidecar or depending on `sf electivus`. This runtime is an intentional IntelliJ-only implementation: the VS Code extension and Salesforce CLI plugin remain adapters over the TypeScript `@alv/core`. Language-neutral fixtures and conformance contracts must cover the shared invariants and DTO semantics so behavior drift between the Kotlin and TypeScript runtimes is detected rather than silently accepted.

The Salesforce CLI remains required only as the authentication broker. The Kotlin runtime discovers orgs through `sf org list --json`, obtains an access token and instance URL through `sf org display --json`, keeps credentials in memory without logging them, and performs Salesforce Tooling REST operations itself. An authentication failure may trigger one credential refresh and retry; the plugin does not read private Salesforce CLI auth files or own a second OAuth lifecycle.

The IntelliJ presentation is implemented with Kotlin and the native IntelliJ Platform UI rather than JCEF, and it does not reuse the React webview components. Functional parity is specified through observable behavior and shared fixtures instead of shared UI code, while each IDE remains free to follow its own interaction conventions.

One lazily initialized project tool window contains separate Logs and Debug Flags tabs. A parsed Apex log opens in a dedicated IntelliJ editor, while Open Raw Log opens the dependable local `.log` file in the standard text editor for the Replay Handoff to Illuminated Cloud 2.

The first release supports IntelliJ IDEA 2026.1 and 2026.2. It compiles against the 2026.1 platform and Java 21 baseline, runs Plugin Verifier against both supported IDE lines, and adds a real smoke test against the locally installed IntelliJ IDEA Ultimate 2026.2.

The declared products are IntelliJ IDEA Community and Ultimate. Illuminated Cloud 2 is an optional runtime integration for Replay Handoff rather than a required plugin dependency; other JetBrains IDE products are outside the first-release compatibility claim.
