# Core behavioral contract corpus

`v1/` records the public behavior of the TypeScript core used by the VS Code extension and Salesforce CLI plugin. The TypeScript runner validates the JSON scenarios against the versioned schema and executes them through `createApexLogViewerCore`. A corpus version is immutable after release except for corrections that do not change its meaning; incompatible contract changes start a new versioned directory.

Each scenario declares:

- the public facade operation and JSON-compatible request;
- real workspace files before and after the operation;
- unordered, scripted process and HTTP interactions at system boundaries; and
- either the complete observable result DTO or a classified failure.

`<workspace>` in public requests and scripted process/HTTP values is replaced with a fresh absolute temporary directory for each scenario. Paths in observable results are normalized back to forward-slash `<workspace>/...` values before comparison. Workspace file paths are always relative and cannot escape the temporary directory.

The doubles match complete requests without relying on invocation order. Each scripted request must be unique within its boundary; repeated semantic calls use one interaction with an ordered `responses` queue. Ambiguous duplicates, exhausted or unconsumed responses, and unexpected calls fail the runner. Scenarios must not encode private class structure, helper calls, or incidental concurrency order.

Run the core contract scenarios with:

```text
pnpm run test:conformance
```

These scenarios also run in `pnpm run test:core` and require neither Salesforce credentials nor an IDE. The corpus establishes bootstrap, DTO, validation, failure, workspace, external-boundary, canonical and legacy local-first resolution, and local triage primitives. Other core suites additionally cover authentication retry, Tooling pagination, path safety, parser and search behavior, cancellation, partial failures, and purge; future contract scenarios extend the same versioned shape.
