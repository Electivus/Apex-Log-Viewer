# Monorepo Security Hardening Design

Date: 2026-04-05
Repository: `Electivus/Apex-Log-Viewer`
Primary goal: materially reduce supply-chain and trust-boundary risk across the monorepo and its directly trusted auxiliary repositories.

## Summary

This design hardens the repository in four linked layers:

1. GitHub governance and workflow immutability.
2. Monorepo dependency controls across npm and Rust.
3. Runtime, webview, and local file trust boundaries inside the extension.
4. Direct trust-boundary treatment for the `tree-sitter-sfapex` fork that is currently consumed as a git dependency.

The approved direction is the maximum lock-down option, not an advisory-only pass. The design therefore prefers enforced controls over documentation-only guidance when the repository can support them without breaking unavoidable public-repo workflows such as fork PRs.

## Context

Recent supply-chain attacks such as the March 2026 Axios compromise showed that modern attacks often arrive through trusted package distribution paths, install-time hooks, mutable workflow references, and maintainer-account compromise rather than through obvious application-layer bugs.

This repository is a public monorepo with multiple trust surfaces:

- TypeScript and npm workflows at the repository root.
- A Rust workspace under `crates/`.
- GitHub Actions release and publishing workflows.
- A VS Code extension that launches local executables and exchanges structured messages with webviews.
- A direct git dependency on `tree-sitter-sfapex`, pinned to commit `685c57c5461eb247d019b244f2130e198c7cc706`.

The repository already has meaningful protections in place:

- A default-branch ruleset requiring pull requests, signed commits, linear history, CodeQL, code-quality checks, stale-review dismissal, and review-thread resolution.
- Dependabot configuration for npm, Cargo, and GitHub Actions.
- Secret scanning and push protection enabled at the repository level.
- A CSP for extension webviews.

The repository also has important gaps:

- GitHub Actions currently allows `all` actions and does not require SHA pinning.
- GitHub Actions can approve pull request reviews.
- The default-branch ruleset does not currently require code-owner review.
- The current tag ruleset protects `v*` tags but does not cover `rust-v*` release tags used by the Rust CLI release workflow.
- There is no dedicated dependency-review gate on pull requests.
- The Rust workspace currently has no checked-in `Cargo.lock` and no visible `cargo-audit`, `cargo-deny`, or `cargo-vet` lane.
- The extension accepts a manual runtime executable override as any non-empty string.
- Webview message handling is typed but not runtime-validated at the boundary.
- The `tree-sitter-sfapex` fork is part of the trust boundary and is materially less hardened than this repository.

## Approaches Considered

### Approach A: Minimal enforcement

Add documentation and a small number of advisory checks while leaving the current GitHub and dependency posture mostly intact.

Why rejected:

- Too much of the protection would remain in reviewer memory.
- It would not materially reduce workflow or dependency compromise risk.
- It would not match the approved maximum lock-down direction.

### Approach B: Balanced hardening

Add workflow immutability, dependency-review gating, and a focused code sweep while avoiding stricter repo-policy changes that may increase maintainer friction.

Why rejected:

- Stronger than the current baseline, but it still treats some important escape hatches as acceptable defaults.
- The user explicitly approved stricter controls even when they add friction.

### Approach C: Maximum lock-down

Treat supply-chain and trust-boundary controls as enforceable policy across GitHub settings, workflows, dependency intake, and runtime/webview boundaries.

Why selected:

- Best fit for the user request and risk posture.
- Most likely to prevent regression through automation rather than reviewer memory.
- Explicitly covers npm, Rust, GitHub Actions, extension code, and the parser fork as one trust system.

## 1. GitHub Governance and Workflow Hardening

The repository should continue using rulesets rather than classic branch protection. The current default-branch ruleset should be tightened instead of replaced.

### In-repo controls

Committed repository changes will:

- Pin every third-party GitHub Action and reusable workflow reference to a full commit SHA.
- Add regression tests that fail if workflow references drift back to mutable tags or branches.
- Add a dedicated dependency-review workflow for `pull_request`.
- Add `CODEOWNERS` coverage for:
  - `.github/workflows/`
  - release and publish scripts
  - runtime bundle metadata
  - lockfiles and dependency manifests
  - parser dependency intake points
- Document the hardened governance model in repository docs.

### GitHub-side controls

GitHub-side changes applied with `gh` will:

- Update the existing default-branch ruleset to require code-owner review.
- Preserve current ruleset strengths such as signed commits, PRs, linear history, CodeQL, and thread resolution.
- Extend tag protection so Rust release tags such as `rust-v*` are protected alongside `v*` tags, either by expanding the existing tag ruleset or by adding a dedicated Rust-release tag ruleset.
- Disable GitHub Actions from approving pull request reviews.
- Require SHA-pinned actions at the repository level.
- Restrict allowed actions away from `all` to GitHub-owned actions plus the explicitly required third-party actions and reusable workflows.
- Enable any missing repository security features that are supported and appropriate for this public repository, including private vulnerability reporting if available.

### Required-check policy

Required checks must remain deterministic for public PRs. Secret-dependent E2E jobs will not become required status checks because they are not reliable for fork-based pull requests.

## 2. Monorepo Dependency and Provenance Controls

Dependency trust will be treated as a monorepo concern, not an npm-only concern.

### npm lane

The npm lane will:

- Add a PR dependency-review gate that blocks risky dependency additions or updates according to defined thresholds.
- Add repository tests or scripts that reject new non-registry dependency sources such as `git+https`, tarball URLs, or arbitrary remote URLs unless explicitly allowlisted.
- Keep relying on `package-lock.json` plus `npm ci` for reproducibility rather than rewriting all semver ranges to exact versions.
- Add verification such as `npm audit signatures` where it is compatible with the workspace and CI environment.

### Rust lane

The Rust lane will:

- Add and maintain a checked-in workspace `Cargo.lock`.
- Add at least one Rust dependency-security gate such as `cargo-deny` or `cargo-audit`.
- Enforce review visibility for Rust manifests and lockfile changes alongside npm changes.
- Keep the Rust workspace covered by repo ownership and CI policy rather than treating it as a secondary surface.

### Policy for non-standard sources

New direct dependencies from mutable or non-registry sources should fail by default. Exceptions require explicit documentation and tests.

## 3. `tree-sitter-sfapex` Fork Strategy

The `tree-sitter-sfapex` fork is a first-class trust boundary because this repository currently consumes it directly as a git dependency.

### Current state

Local analysis under `D:/git/tree-sitter-sfapex` confirmed:

- The repository consumed here is `manoelcalixto/tree-sitter-sfapex`.
- The pinned commit matches the dependency reference used by this monorepo.
- The fork currently has no rulesets.
- The fork allows `all` GitHub Actions and does not require SHA pinning.
- The fork uses mutable workflow references, including `tree-sitter/workflows/.github/workflows/package-npm.yml@main`.
- The fork metadata still points at the upstream `aheber/tree-sitter-sfapex` repository rather than the fork.

### Phase 1: immediate containment

Immediate actions for the fork will:

- Apply repository-level GitHub hardening similar to the main monorepo where feasible.
- Pin its Actions and reusable workflow references.
- Correct package and Cargo metadata so the fork accurately identifies itself as the source of the published artifacts it controls.
- Add a clear publishing and review policy if the fork will continue to produce artifacts.

### Phase 2: exit from direct git intake

The steady-state goal is to stop consuming the parser as a direct git dependency from this monorepo. Preferred end states are:

- Consume a reviewed published artifact from a controlled release process, or
- Vendor the specific generated parser artifacts this monorepo needs under version control with explicit update procedures.

The git dependency may remain temporarily only as a controlled exception while the fork is hardened or replaced.

## 4. Extension Runtime and Webview Trust Boundaries

The code sweep will focus on real trust boundaries in this VS Code extension rather than generic browser-only hardening.

### Runtime executable resolution

The manual runtime override should stop accepting any non-empty string as a trusted executable path.

The hardened behavior should:

- Require the configured override path to resolve to an existing local file.
- Reject obviously unsafe or non-file values.
- Warn clearly when the bundled runtime is bypassed.
- Consider an explicit unsafe-override confirmation path for manual executable overrides.

### Process execution

Process-spawn paths should remain argument-based and avoid shell expansion, but they also need tighter policy boundaries.

The sweep should:

- Review which executables can be launched and from where.
- Confirm that runtime and CLI invocations remain constrained to expected binaries and validated paths.
- Ensure error handling and telemetry do not turn command failures into a secret or path disclosure channel beyond what is operationally necessary.

### Runtime protocol validation

The JSONL RPC boundary between the extension and runtime should fail closed on malformed frames and unexpected message shapes.

The sweep should:

- Verify malformed runtime output cannot be treated as trusted data.
- Add tests for invalid or truncated protocol frames where coverage is missing.
- Keep the runtime boundary explicit and narrow.

### Webview message validation

Typed TypeScript message unions are not enough at the extension boundary.

The sweep should add explicit runtime validation for:

- message type names
- log IDs
- org targets
- search query payloads
- logs-columns payloads
- debug-flags actions and payloads

Malformed or oversized payloads should be rejected before they reach handler logic.

### File and URI handling

The sweep should verify that:

- log IDs and usernames cannot redirect file operations outside the intended `apexlogs/` model
- replay-launch paths only operate on validated local log files
- any command entrypoints that open logs from user-controlled paths or URIs remain scheme-restricted and path-safe

## 5. Verification and Regression Prevention

Hardening must be verifiable and auditable. Each control added should have an associated verification strategy.

### Repository-code verification

Repository-code verification will include:

- workflow regression tests
- dependency policy tests
- runtime override validation tests
- message-boundary validation tests
- relevant TypeScript, script, and Rust test lanes

### GitHub-side verification

GitHub-side verification will include fresh `gh api` reads after changes to confirm:

- ruleset contents
- Actions permissions
- workflow approval settings
- allowed-actions policy
- SHA-pinning requirement

Expected settings will also be documented so the desired posture remains auditable even though not every setting is versioned in git.

## 6. Phasing

Implementation should be staged in this order:

1. Governance and workflow immutability.
2. Dependency controls for npm and Rust.
3. `tree-sitter-sfapex` containment and replacement path.
4. Extension/runtime/webview code hardening.
5. Verification and documentation cleanup.

This order front-loads the controls that prevent new regressions while the code sweep is still in progress.

## 7. Non-Goals

The following are out of scope unless later findings require them:

- Broad UI redesign or cosmetic webview refactors.
- Replacing the existing webview CSP with browser-only controls that do not materially improve a VS Code webview context.
- Enforcing secret-dependent E2E checks as required PR gates.
- Unrelated refactors that do not contribute to the stated hardening objectives.

## 8. Success Criteria

This effort is successful when all of the following are true:

1. New risky workflow or dependency regressions fail automatically in CI.
2. GitHub-side repository settings align with the hardened design and can be re-verified with `gh`.
3. npm and Rust both have explicit supply-chain controls instead of relying on default tooling behavior alone.
4. The extension no longer treats runtime overrides and webview payloads as trusted by default.
5. The `tree-sitter-sfapex` dependency is either materially safer to consume or on a documented, controlled path away from direct git consumption.

## References

- GitHub secure use reference for Actions, especially full-SHA pinning and least privilege.
- GitHub dependency review action guidance for PR-time dependency enforcement.
- npm provenance and attestation guidance for trusted publishing and verification.
- Microsoft incident guidance for the 2026 Axios compromise as current supply-chain threat context.
