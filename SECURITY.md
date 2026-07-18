# Security Policy

## Supported Versions

This project is currently pre-1.0. We support security fixes only for the
latest released version of the VS Code extension published to the Marketplace.

- Latest release (Marketplace): Supported
- Older releases: Not supported — please upgrade to the latest

Links
- Marketplace listing:
  https://marketplace.visualstudio.com/items?itemName=electivus.apex-log-viewer
- GitHub releases:
  https://github.com/Electivus/Apex-Log-Viewer/releases

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
- Direct private report link:
  https://github.com/Electivus/Apex-Log-Viewer/security/advisories/new

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
- pnpm allows dependency build scripts only for the packages listed in
  `allowBuilds`, blocks exotic transitive dependency sources, waits 24 hours
  before resolving newly published versions without a permissive fallback, and
  rejects dependency versions whose registry trust level has decreased.
- Regular Dependabot version updates inherit these pnpm policies. Dependabot
  security updates intentionally bypass only the 24-hour release-age delay so
  urgent fixes are not held back; their pull requests still pass the remaining
  pnpm policies and repository CI gates.
- Before any workflow `pnpm install --frozen-lockfile`, CI runs `node scripts/check-dependency-sources.mjs`
  to block unapproved dependency source types in both manifests and
  `pnpm-lock.yaml`, including arbitrary git, tarball, file, or URL sources.
- CI also runs `pnpm audit signatures` so npm registry signature/attestation
  coverage is validated as part of the gated path.
- Workflow files, package manifests, lockfiles, plugin packaging scripts, and
  release/publish scripts are protected by `CODEOWNERS`.

Exceptions

- Any exception to these controls should be rare, reviewed by maintainers, and
  documented in the relevant pull request with the specific reason and planned
  follow-up.
- Trust-policy exceptions in `pnpm-workspace.yaml` must select exact package
  versions already reviewed in the lockfile. The current exceptions grandfather
  signed versions that predate this control; package-wide selectors are not
  approved.
- There are currently no approved non-registry JavaScript dependency-source
  exceptions.

## Hardening Feedback

We welcome non‑sensitive hardening proposals and dependency upgrade suggestions
as regular GitHub issues. For anything that could have security impact, please
use the private reporting channel above.
