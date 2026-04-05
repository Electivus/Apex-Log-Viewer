# Security Policy

## Supported Versions

This project is currently pre-1.0. We support security fixes only for the
latest released version of the VS Code extension published to the Marketplace.

- Latest release (Marketplace): Supported
- Older releases: Not supported — please upgrade to the latest

Notes
- Trunk-based: usamos `main` como tronco. Trabalhamos em branches curtas de
  feature/fix que fazem PR para `main`. Correções de segurança são aplicadas em
  `main`. Em casos críticos, podemos fazer um hotfix direto em `main`.
- Veja GitHub Releases ou a listagem no Marketplace para identificar a versão mais recente.

## Reporting a Vulnerability

Please do not file public issues for security problems.

Preferred channel
- Use GitHub Private Vulnerability Reporting for this repository:
  Security tab → “Report a vulnerability” (creates a private GitHub Security
  Advisory draft with the maintainers).

If you cannot use the private reporting feature
- Do not disclose details publicly. Open a minimal issue asking for a secure
  contact channel (no technical details), and we will respond with instructions
  within 48 hours; or reach the maintainers via the contact information linked
  from the repository/Marketplace profile.

What to include
- A clear description of the issue, impact, and severity.
- Reproduction steps, PoC (if available), and affected version(s).
- Environment details (OS, VS Code version, extension version).

Sensitive data handling
- This extension interacts with Salesforce via the Salesforce CLI. Do not share
  organization credentials, access tokens, or logs containing customer or org
  identifiers. Redact any secrets and sensitive fields from PoCs and logs.
- Test against non-production orgs (e.g., scratch orgs) when possible.

Our commitment
- Acknowledge receipt within 48 hours (business days).
- Triage and provide an initial assessment within 5 business days.
- Target fix timelines (guideline; may vary by complexity):
  - Critical/High: 14 days
  - Medium: 30 days
  - Low: 90 days
- We will coordinate disclosure, credit researchers (if desired), and publish
  notes in a GitHub Security Advisory and the CHANGELOG.
- CVE assignment: If applicable, we will request a CVE via GitHub Security
  Advisories during the publication process.

## Scope

In scope
- Code in this repository (the VS Code extension and its webview assets).

Out of scope
- Vulnerabilities in Salesforce products, Salesforce org configuration, or the
  Salesforce CLI itself (report to Salesforce/SF CLI maintainers instead).
- Third‑party dependencies upstream (unless a vulnerability is directly caused
  by our usage/integration).

## Repository Hardening Controls

The repository enforces a stricter supply-chain posture than a default VS Code
extension project. Maintainers should expect some PR and release friction when
security controls detect risk.

- GitHub Actions workflow references are pinned to full commit SHAs instead of
  mutable tags.
- Pull requests run dependency review and fail on new moderate-or-higher risk
  dependencies in runtime or development scopes.
- CI runs `npm run security:dependency-sources` to block unapproved dependency
  source types such as arbitrary git, tarball, file, or URL dependencies.
- CI also runs `npm audit signatures` so npm registry signature/attestation
  coverage is validated as part of the gated path.
- The Rust workspace keeps a checked-in `Cargo.lock` and uses `cargo-deny`
  with the committed `deny.toml` allowlist for advisory, license, and source
  checks.
- Workflow files, package manifests, lockfiles, runtime bundle metadata, and
  release/publish scripts are protected by `CODEOWNERS`.

Exceptions

- Any exception to these controls should be rare, reviewed by maintainers, and
  documented in the relevant pull request with the specific reason and planned
  follow-up.
- The only currently approved non-registry JavaScript dependency source is the
  pinned `tree-sitter-sfapex` git dependency. Changes to that exception should
  be treated as a security-sensitive review item.

## Hardening Feedback

We welcome non‑sensitive hardening proposals and dependency upgrade suggestions
as regular GitHub issues. For anything that could have security impact, please
use the private reporting channel above.
