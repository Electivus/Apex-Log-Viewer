# Keep surface snapshots outside the Webview Session

Status: accepted

## Context

The Logs and Tail providers independently own the same webview mechanics: host binding, delayed mount, readiness, visibility, delivery recovery, retries, stale-mount rejection, and diagnostics. Their presentation state and authoritative replay snapshots differ, so moving those snapshots into a shared message journal would make the common interface broad and policy-heavy.

## Decision

The VS Code extension will use one rebindable Webview Session per live surface. The session owns host attachment, delayed mount and readiness, visibility transitions, explicitly classified outbound delivery, latest-snapshot replay, bounded retry, generation safety, validated inbound routing, temporary detach, final disposal, and mechanical diagnostics.

Logs and Tail retain presentation, authoritative snapshot state, bootstrap workflows, replay content, surface message handling, workflow errors, and surface diagnostics. A surface classifies each outbound delivery as replayable or transient and produces its latest replay batch only when the session requests it. Replay succeeds only when every post is accepted; the session does not infer replay policy from message types or retain intermediate payloads.

Detach callbacks receive a payload-free mechanical reason so a surface can preserve its established policy across host replacement, host disposal, explicit detach, and final disposal without reimplementing host lifecycle detection.

Readiness-timeout recovery is a host capability. Sidebar adapters may remount the current host, while editor adapters may replace their panel; the session contains no panel-versus-editor branch. Timing control remains a private construction seam used by production and deterministic contract tests, not a surface-provider dependency.

The lifecycle defaults remain a one-second mount delay, a thirty-second readiness timeout, and three replay retries at 250 milliseconds. Sidebar and editor registrations continue to use `retainContextWhenHidden`.

Mechanical behavior is verified through the public Webview Session interface with a fake host and a private fake clock. Host-adapter tests verify in-place sidebar remount and editor replacement. Logs and Tail provider tests verify only surface-owned snapshots, bootstrap and workflow decisions, message validation and handling, delivery classifications through observable outcomes, errors, and recovery outcomes.

## Consequences

- Logs and Tail can migrate independently onto one proven lifecycle contract.
- Host replacement preserves logical replay intent without preserving stale host work.
- Mechanical diagnostics remain payload-free and can be composed with surface-owned diagnostics.
- Surface snapshots stay local and understandable, at the cost of each surface supplying mount, validation, message, and latest-snapshot callbacks.
- The completed migration has one production lifecycle implementation. Host adapters expose recovery capabilities directly; no host-kind discriminator or provider-owned lifecycle state remains.
