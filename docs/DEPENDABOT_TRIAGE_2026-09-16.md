# Dependabot triage, 2026-09-16

The inventory contained 25 open Dependabot PRs. Review started from `main` at
`5172cab7f6fe1ca3c6aae94eb8386dc0f575d64a`. Their manifest and workflow changes
were compared with current main, and compatible changes were assembled on that
base with a freshly resolved, frozen pnpm lockfile. This avoids applying old
workflow context over the recent native Linux E2E changes.

## Disposition

"Consolidate" means the proposed versions are included in the replacement PR;
the original PR can be closed as superseded after that replacement merges.
"Defer" means the dependency-only update is incompatible with the current
toolchain, with a bounded version ignore and a concrete condition for revisiting it.

| PR                                                             | Update                                      | Disposition / evidence                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [978](https://github.com/Electivus/Apex-Log-Viewer/pull/978)   | setup-node 7.0.0                            | Consolidate; fix workflow assertions tied to the previous SHA.                                              |
| [980](https://github.com/Electivus/Apex-Log-Viewer/pull/980)   | TypeScript 7.0.2 / typescript-eslint 8.70.0 | Defer; removed compiler options and unsupported compiler peer ranges.                                       |
| [989](https://github.com/Electivus/Apex-Log-Viewer/pull/989)   | checkout 7.0.1                              | Consolidate; refresh validation on current main.                                                            |
| [991](https://github.com/Electivus/Apex-Log-Viewer/pull/991)   | scorecard-action 2.4.4                      | Consolidate; test full-SHA pinning rather than one historical release.                                      |
| [993](https://github.com/Electivus/Apex-Log-Viewer/pull/993)   | Radix UI group                              | Consolidate.                                                                                                |
| [1001](https://github.com/Electivus/Apex-Log-Viewer/pull/1001) | sf-plugins-core 12.2.28                     | Consolidate with Salesforce runtime validation.                                                             |
| [1021](https://github.com/Electivus/Apex-Log-Viewer/pull/1021) | React / DOM / types 19.3.0                  | Consolidate as one runtime/type family.                                                                     |
| [1067](https://github.com/Electivus/Apex-Log-Viewer/pull/1067) | esbuild 0.28.2                              | Consolidate.                                                                                                |
| [1081](https://github.com/Electivus/Apex-Log-Viewer/pull/1081) | tsx 4.23.13                                 | Consolidate across the three shared/plugin packages.                                                        |
| [1083](https://github.com/Electivus/Apex-Log-Viewer/pull/1083) | oclif packaging CLI 6.0.0                   | Consolidate; this development executable is separate from the plugin's oclif 4 runtime.                     |
| [1084](https://github.com/Electivus/Apex-Log-Viewer/pull/1084) | sharp 0.35.4                                | Consolidate.                                                                                                |
| [1087](https://github.com/Electivus/Apex-Log-Viewer/pull/1087) | Jest / Testing Library / jsdom group        | Consolidate; Node 24.15.0 meets the new jsdom floor.                                                        |
| [1089](https://github.com/Electivus/Apex-Log-Viewer/pull/1089) | postcss 8.5.28                              | Consolidate.                                                                                                |
| [1091](https://github.com/Electivus/Apex-Log-Viewer/pull/1091) | mocha 12.0.1                                | Consolidate; verify extension-host loading and integration tests.                                           |
| [1092](https://github.com/Electivus/Apex-Log-Viewer/pull/1092) | @oclif/core runtime 5.0.0                   | Defer; conflicts with oclif 4 types exported by sf-plugins-core 12.                                         |
| [1100](https://github.com/Electivus/Apex-Log-Viewer/pull/1100) | codeql-action 4.38.0                        | Consolidate.                                                                                                |
| [1101](https://github.com/Electivus/Apex-Log-Viewer/pull/1101) | setup-java 6.0.1                            | Consolidate, retaining Java 21.                                                                             |
| [1102](https://github.com/Electivus/Apex-Log-Viewer/pull/1102) | undici 8.10.2                               | Consolidate; real-org telemetry remains an integration gate.                                                |
| [1103](https://github.com/Electivus/Apex-Log-Viewer/pull/1103) | react-window 2.3.1                          | Consolidate in both root and webview manifests.                                                             |
| [1104](https://github.com/Electivus/Apex-Log-Viewer/pull/1104) | @playwright/test 1.63.0                     | Consolidate with #1108; independent bumps fail the version-alignment contract.                              |
| [1105](https://github.com/Electivus/Apex-Log-Viewer/pull/1105) | eslint 10.10.0                              | Consolidate.                                                                                                |
| [1106](https://github.com/Electivus/Apex-Log-Viewer/pull/1106) | skills 1.5.26                               | Consolidate; verify an exact manifest pin against the installed CLI and run actual isolated installations.  |
| [1107](https://github.com/Electivus/Apex-Log-Viewer/pull/1107) | lucide-react 1.45.0                         | Consolidate.                                                                                                |
| [1108](https://github.com/Electivus/Apex-Log-Viewer/pull/1108) | playwright 1.63.0                           | Consolidate with #1104.                                                                                     |
| [1109](https://github.com/Electivus/Apex-Log-Viewer/pull/1109) | @salesforce/core 9.1.11                     | Consolidate in core and CLI adapter; require fresh real-org checks because the original PR had UI failures. |

## Reproduced incompatibilities

- **#980**, checkout `1bef6b239fc0101d7ce59d702a629cfdd4ed51b9`:
  `pnpm install --frozen-lockfile` succeeds, but `pnpm run check-types` fails
  with TS5090/TS5102 because `baseUrl` was removed and path mappings are not
  relative. The published `ts-jest@29.4.12` peer range requires TypeScript `<7`,
  and `@typescript-eslint/parser@8.70.0` requires `<6.1.0`. Revisit TypeScript 7
  with supported transformer/parser releases and a coordinated tsconfig migration.
- **#1092**, checkout `88c3bb1d33d2503eec167448495b1e47c241e65a`:
  frozen install succeeds, but `pnpm run check-types` fails with TS2883 in
  `packages/sf-plugin/src/flags.ts`. `sf-plugins-core@12.2.28` depends on
  `@oclif/core:^4.11.4`; its flag types cannot be exposed through a direct oclif 5
  dependency. Revisit with a compatible Salesforce adapter/runtime migration.

These ignores cover only TypeScript 7.x and oclif runtime 5.x. They are not
blanket exclusions of all future majors. Existing Node, VS Code API and
sf-plugins-core major constraints remain intact.

## Configuration changes

- Keep Playwright and its test runner together for every version-update level.
  Place specific families before the production/development fallback groups;
  add ESLint to TypeScript tooling and PostCSS/autoprefixer to Tailwind.
- Keep Salesforce runtime packages together, while leaving the independently
  executed `oclif` packaging CLI outside that runtime family.
- Limit version-update PRs to 10 npm, 3 Actions and 3 Gradle. Run weekly at
  06:00 America/Bahia on Monday, Tuesday and Wednesday respectively.
- Use a three-day npm cooldown, above pnpm's one-day minimum release age.
  Group security updates separately; their scheduling is not delayed by the
  version-update cooldown or version-update PR limit.
- Add the previously uncovered native IntelliJ Gradle project. Dependency
  verification metadata must still be reviewed and all checksum gates retained.
- Keep unrelated majors separate from routine patch/minor fallback groups.

The grouping order, cooldown and security-update behavior follow the
[GitHub Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
The YAML is also checked against the [Dependabot schema](https://json.schemastore.org/dependabot-2.0.json).

## Action provenance

GitHub's commit API resolved each upstream release tag to the exact proposed
SHA, with commit verification successful for all five:

| Action                | Release | SHA                                        |
| --------------------- | ------- | ------------------------------------------ |
| actions/checkout      | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node    | v7.0.0  | `820762786026740c76f36085b0efc47a31fe5020` |
| actions/setup-java    | v6.0.1  | `de7274f081f381c8f8158605e0321c36c376e2e6` |
| github/codeql-action  | v4.38.0 | `b96794f015dfd88f77b49b1c93e0fa7110f94c63` |
| ossf/scorecard-action | v2.4.4  | `2d1146689b8cda280b9bc96326124645441f03bc` |

The workflow tests continue requiring the intended action identity, full SHA
pinning, matching setup/restore actions, and the existing runtime/order policy.
They no longer require an obsolete literal release SHA.
