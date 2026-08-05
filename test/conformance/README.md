# Dual-runtime conformance corpus

`v1/` is the language-neutral source of truth for behavior shared by the TypeScript and Kotlin runtime facades. Both runners execute the same JSON scenario files, and the dual command validates them against the versioned schema before either facade can pass. A corpus version is immutable after release except for corrections that do not change its meaning; incompatible contract changes start a new versioned directory.

Each scenario declares:

- the public facade operation and JSON-compatible request;
- real workspace files before and after the operation;
- unordered, scripted process and HTTP interactions at system boundaries; and
- either the complete observable result DTO or a classified failure.

`<workspace>` is replaced with a fresh absolute temporary directory for each runner. Paths in observable results are normalized back to forward-slash `<workspace>/...` values before comparison. Workspace file paths are always relative and cannot escape the temporary directory.

The doubles match complete requests without relying on invocation order. Unexpected or unconsumed interactions fail the runner. Scenarios must not encode private class structure, helper calls, or incidental concurrency order.

Run both facades with:

```text
pnpm run test:conformance
```

The initial scenarios establish bootstrap, DTO, validation, failure, workspace, and external-boundary primitives. Later runtime tickets extend the same shape with auth, Tooling, lifecycle, parser, triage, settings, telemetry, and Debug Flags operations.
