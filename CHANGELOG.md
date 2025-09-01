# Changelog

## Unreleased

### Features

- Allow expanding and collapsing method frames in Apex log diagram.

## [0.4.0](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.3.1...v0.4.0) (2025-09-01)

### Features

- Add Apex log diagram visualization (no external libs) ([#93](https://github.com/Electivus/Apex-Log-Viewer/pull/93)) ([39290af](https://github.com/Electivus/Apex-Log-Viewer/commit/39290af))
- Tail Apex Logs via Streaming API (/systemTopic/Logging) ([#43](https://github.com/Electivus/Apex-Log-Viewer/pull/43)) ([a55bfa7](https://github.com/Electivus/Apex-Log-Viewer/commit/a55bfa7))
- Tail: virtualized list, configurable buffer, viewport-aware paging ([#72](https://github.com/Electivus/Apex-Log-Viewer/pull/72)) ([dc117d3](https://github.com/Electivus/Apex-Log-Viewer/commit/dc117d3))
- Tail: smart autoscroll and dynamic height ([#73](https://github.com/Electivus/Apex-Log-Viewer/pull/73)) ([3b04179](https://github.com/Electivus/Apex-Log-Viewer/commit/3b04179))
- Cache org list and support forced refresh ([#79](https://github.com/Electivus/Apex-Log-Viewer/pull/79)) ([f425a32](https://github.com/Electivus/Apex-Log-Viewer/commit/f425a32))
- Rename panels to "Apex Logs" and "Apex Logs Tail" ([#49](https://github.com/Electivus/Apex-Log-Viewer/pull/49)) ([494c8c8](https://github.com/Electivus/Apex-Log-Viewer/commit/494c8c8))

### Bug Fixes

- Terminate Salesforce CLI commands after ~30s to prevent hanging ([#90](https://github.com/Electivus/Apex-Log-Viewer/pull/90), [#91](https://github.com/Electivus/Apex-Log-Viewer/pull/91)) ([8b8f40d](https://github.com/Electivus/Apex-Log-Viewer/commit/8b8f40d), [4653686](https://github.com/Electivus/Apex-Log-Viewer/commit/4653686))
- Reset TailService resources on stop ([#75](https://github.com/Electivus/Apex-Log-Viewer/pull/75)) ([01a8496](https://github.com/Electivus/Apex-Log-Viewer/commit/01a8496))
- Stop TailService on webview dispose; allow tail after reopen ([#42](https://github.com/Electivus/Apex-Log-Viewer/pull/42)) ([7f69818](https://github.com/Electivus/Apex-Log-Viewer/commit/7f69818))
- Log ignored errors in catch blocks ([#92](https://github.com/Electivus/Apex-Log-Viewer/pull/92)) ([20e3094](https://github.com/Electivus/Apex-Log-Viewer/commit/20e3094))
- Log failed auth token refresh ([#77](https://github.com/Electivus/Apex-Log-Viewer/pull/77)) ([01c26e5](https://github.com/Electivus/Apex-Log-Viewer/commit/01c26e5))
- Remove duplicate resolving PATH finalizer ([#32](https://github.com/Electivus/Apex-Log-Viewer/pull/32)) ([3e751e1](https://github.com/Electivus/Apex-Log-Viewer/commit/3e751e1))
- Log sendOrgs errors in tail view ([#39](https://github.com/Electivus/Apex-Log-Viewer/pull/39)) ([37035bb](https://github.com/Electivus/Apex-Log-Viewer/commit/37035bb))

### Docs

- Add architecture overview ([#45](https://github.com/Electivus/Apex-Log-Viewer/pull/45)) ([40c543b](https://github.com/Electivus/Apex-Log-Viewer/commit/40c543b))
- Inline usage guide in README ([#44](https://github.com/Electivus/Apex-Log-Viewer/pull/44)) ([007f370](https://github.com/Electivus/Apex-Log-Viewer/commit/007f370))
- Add settings guide ([#46](https://github.com/Electivus/Apex-Log-Viewer/pull/46)) ([3833fae](https://github.com/Electivus/Apex-Log-Viewer/commit/3833fae))

### Build

- Bundle extension runtime with esbuild; exclude node_modules; stub 'bfj' ([#94](https://github.com/Electivus/Apex-Log-Viewer/pull/94)) ([828c53e](https://github.com/Electivus/Apex-Log-Viewer/commit/828c53e))
- Specify Node 20 engine and document requirement ([#85](https://github.com/Electivus/Apex-Log-Viewer/pull/85)) ([6d98c3d](https://github.com/Electivus/Apex-Log-Viewer/commit/6d98c3d))

### Refactoring

- Extract TailService and streaming utilities; typed helpers and module splits ([2233539](https://github.com/Electivus/Apex-Log-Viewer/commit/2233539), [73dab59](https://github.com/Electivus/Apex-Log-Viewer/commit/73dab59), [18c2b03](https://github.com/Electivus/Apex-Log-Viewer/commit/18c2b03), [05e7ad4](https://github.com/Electivus/Apex-Log-Viewer/commit/05e7ad4))

## [0.3.1](https://github.com/Electivus/Apex-Log-Viewer/compare/apex-log-viewer-v0.3.1...apex-log-viewer-v0.3.1) (2025-08-30)

### ⚠ BREAKING CHANGES

- **runner:** harden VS Code tests; docs and CI updates ([#16](https://github.com/Electivus/Apex-Log-Viewer/issues/16))

### Features

- Add loading state handling and new configuration options for Apex Log Viewer ([cc2692f](https://github.com/Electivus/Apex-Log-Viewer/commit/cc2692f28305237ef158f5d355e64c32dd524b91))
- **docs:** document release channels (odd=pre, even=stable)\n\nRelease-As: 0.1.0 ([8fdd722](https://github.com/Electivus/Apex-Log-Viewer/commit/8fdd722102dc8837b007016088b5a19932378ed1))
- Enhance CI workflow to auto-detect release channel and update packaging process for stable and pre-release versions ([d0780f9](https://github.com/Electivus/Apex-Log-Viewer/commit/d0780f94f81b7f65abc0884749db5e51fa0b81ae))
- Implement background warm-up for Apex Replay Debugger and enhance log viewing experience ([141b1e3](https://github.com/Electivus/Apex-Log-Viewer/commit/141b1e392c0aa7bd971d956177be5d84f570ddf0))
- Implement log viewing and tailing features ([896ac6c](https://github.com/Electivus/Apex-Log-Viewer/commit/896ac6c14a2dcf100f9d5201fc90ee43847c9932))
- Refactor publish job in CI workflow to enhance version handling and differentiate between stable and pre-release publishing ([5f3f601](https://github.com/Electivus/Apex-Log-Viewer/commit/5f3f6018d825e7676229aa77743ab6244e69a605))
- **tail:** add 'Somente USER_DEBUG' filter to live output ([#20](https://github.com/Electivus/Apex-Log-Viewer/issues/20)) ([2e6fa1c](https://github.com/Electivus/Apex-Log-Viewer/commit/2e6fa1ced333a3eedef36400f804736a6f753a3a))
- **tail:** reduce polling when window inactive using WindowState API (VS Code 1.90+) ([#14](https://github.com/Electivus/Apex-Log-Viewer/issues/14)) ([9023a88](https://github.com/Electivus/Apex-Log-Viewer/commit/9023a88468357310186dbe7f49a17de3df8da699))

### Bug Fixes

- **ci:** remove .vscodeignore to avoid vsce files conflict ([#18](https://github.com/Electivus/Apex-Log-Viewer/issues/18)) ([2866394](https://github.com/Electivus/Apex-Log-Viewer/commit/28663944890ecddf6c381d54bbc8c04708683b65))
- **tests:** improve extension installation and test execution handling ([8c018fe](https://github.com/Electivus/Apex-Log-Viewer/commit/8c018fee9d95835e814c9b5a1bd46b53f27db0f1))

### Refactoring

- migrate from @vscode/test-cli to @vscode/test-electron; update testing scripts and documentation ([be26aba](https://github.com/Electivus/Apex-Log-Viewer/commit/be26abaf4f0afb4131edf96107ec7fb9fc5e85e2))

### Docs

- **changelog:** reset to generated header (managed by Release Please) ([527f0c2](https://github.com/Electivus/Apex-Log-Viewer/commit/527f0c2e13f348d7107bd61fc7cd84a79920d26a))
- forbid manual edits to CHANGELOG and document automated release flow ([#38](https://github.com/Electivus/Apex-Log-Viewer/issues/38)) ([1e6e365](https://github.com/Electivus/Apex-Log-Viewer/commit/1e6e3651dbdabf43354e0d5c956a9cb7e39c9977))
- **test:** document new test scripts and behaviours ([f87dd23](https://github.com/Electivus/Apex-Log-Viewer/commit/f87dd23cd7197a765005afa8e54c3c173867db56))

### Build

- **vsix:** slim VSIX; externalize README images and split CONTRIBUTING ([#13](https://github.com/Electivus/Apex-Log-Viewer/issues/13)) ([f55306b](https://github.com/Electivus/Apex-Log-Viewer/commit/f55306b1c04160bd704fad9a9b15df7347554253))

### CI

- allow manual packaging via workflow_dispatch (tag_name) ([102f8ae](https://github.com/Electivus/Apex-Log-Viewer/commit/102f8ae381ac964a7288b8a603b1c1e72c79c25e))
- enforce conventional commits and automate releases ([#24](https://github.com/Electivus/Apex-Log-Viewer/issues/24)) ([7a03200](https://github.com/Electivus/Apex-Log-Viewer/commit/7a032009c1a091a4b120b991e73ca9c75811a88a))
- execute unit + integration with npm run test:ci ([21332cc](https://github.com/Electivus/Apex-Log-Viewer/commit/21332cc84db98c404cf93b44bf0c45a49013864a))
- guard against manual CHANGELOG.md edits in PRs ([#39](https://github.com/Electivus/Apex-Log-Viewer/issues/39)) ([c9ed3b1](https://github.com/Electivus/Apex-Log-Viewer/commit/c9ed3b1ba42ceb931bca0feb8e790923fb27d95d))
- nightly 4-part version + release safeguards follow-up ([#20](https://github.com/Electivus/Apex-Log-Viewer/issues/20)) ([260fc7f](https://github.com/Electivus/Apex-Log-Viewer/commit/260fc7f92e0b6dd7460f1f51dfe3191571303248))
- prerelease unique version + release safeguards ([#19](https://github.com/Electivus/Apex-Log-Viewer/issues/19)) ([caebbf5](https://github.com/Electivus/Apex-Log-Viewer/commit/caebbf538110f2873b8aaa0b5564074df9694097))
- **prerelease:** fix YAML (heredoc removal) and export env for Marketplace lookup ([#22](https://github.com/Electivus/Apex-Log-Viewer/issues/22)) ([6a2d462](https://github.com/Electivus/Apex-Log-Viewer/commit/6a2d462277f884de9170d2dffe0d522d2c077b5a))
- **prerelease:** increment patch from Marketplace last pre-release ([#21](https://github.com/Electivus/Apex-Log-Viewer/issues/21)) ([3e89b7f](https://github.com/Electivus/Apex-Log-Viewer/commit/3e89b7ff81bfc7a0501751dba3924a17574dd72f))
- **prerelease:** tag GitHub pre-release as pre-&lt;version&gt;; export env for Marketplace lookup; replace heredoc with inline node -e ([#23](https://github.com/Electivus/Apex-Log-Viewer/issues/23)) ([df32134](https://github.com/Electivus/Apex-Log-Viewer/commit/df32134123f87cff89a7ff7c912699913a448459))
- **release-please:** add concurrency; minimize global permissions; elevate only in job ([383b003](https://github.com/Electivus/Apex-Log-Viewer/commit/383b0036053316f3f522b289c38223394d600a2b))
- **release-please:** add issues: write for labeling ([372db00](https://github.com/Electivus/Apex-Log-Viewer/commit/372db003878aed25ebba746689b560bd9236bca6))
- **release-please:** enable PR creation (remove skip); fix YAML indent ([84ebde4](https://github.com/Electivus/Apex-Log-Viewer/commit/84ebde428de7c72079c8b5ddbd83c4bf91ac4012))
- **release-please:** set workflow-level permissions; skip PR when no PAT to bypass policy ([386e687](https://github.com/Electivus/Apex-Log-Viewer/commit/386e6876b029840e3e5bc1766342657359371b3d))
- **release-please:** switch to googleapis/release-please-action@v4; config/manifest; token fallback; pin by SHA ([#16](https://github.com/Electivus/Apex-Log-Viewer/issues/16)) ([3304f82](https://github.com/Electivus/Apex-Log-Viewer/commit/3304f825b470c0440e374d8a81e885fa5506190c))
- **releases:** also run on release edited events ([6f809c9](https://github.com/Electivus/Apex-Log-Viewer/commit/6f809c93c91416b196c09542483e5ca30f660b50))
- **releases:** auto-set prerelease on published releases ([13adfab](https://github.com/Electivus/Apex-Log-Viewer/commit/13adfabd3164fc2ec423632aaf86b4adfbdf38cb))
- **releases:** auto-toggle GitHub Release prerelease flag in packaging jobs ([0acd783](https://github.com/Electivus/Apex-Log-Viewer/commit/0acd7831d362e54eae1be053bdaf5018b0b82592))
- **releases:** contents: write for package/publish ([4f1999c](https://github.com/Electivus/Apex-Log-Viewer/commit/4f1999c0d41c73130d9865de1d1daaa712a71680))
- **releases:** fix YAML indentation (env should be sibling of with) ([5ef3f45](https://github.com/Electivus/Apex-Log-Viewer/commit/5ef3f45f4eb5732eea1f6fbe40b530124c710635))
- **releases:** make concurrency group safe on non-release events; fix YAML validation on push ([b08d9cd](https://github.com/Electivus/Apex-Log-Viewer/commit/b08d9cdae75bca7c47f19e2a2a0296ebbf440589))
- **releases:** remove redundant release-flags workflow ([40a7084](https://github.com/Electivus/Apex-Log-Viewer/commit/40a7084a9ac02ccf8cf505276339da0550fbbe6a))
- **releases:** set GH_TOKEN for gh cli in package/publish jobs ([de3bb37](https://github.com/Electivus/Apex-Log-Viewer/commit/de3bb3777fec3c771a4f0b53ad6e637c34e57511))
- run packaging on release event and tags ([a2fc375](https://github.com/Electivus/Apex-Log-Viewer/commit/a2fc3753bf99ec19e24583e5ae0f50a957dd4dda))
- switch to tag-based releases + auto changelog; remove Release Please ([#17](https://github.com/Electivus/Apex-Log-Viewer/issues/17)) ([b441b2e](https://github.com/Electivus/Apex-Log-Viewer/commit/b441b2e683f621a5ea4850517b1f92623d3b6ad5))

### Tests

- run unit/integration via scoped config; fail on zero tests ([bd6e4f6](https://github.com/Electivus/Apex-Log-Viewer/commit/bd6e4f658954761528def709b68c855d1fc88de8))
- **runner:** harden VS Code tests; docs and CI updates ([#16](https://github.com/Electivus/Apex-Log-Viewer/issues/16)) ([c4f92b9](https://github.com/Electivus/Apex-Log-Viewer/commit/c4f92b92dabc9a447a55f95b29dbc5214617d4d6))

### Chores

- migrate to numeric pre-release scheme (odd minor) ([ad2c6a0](https://github.com/Electivus/Apex-Log-Viewer/commit/ad2c6a0d579a2743f192e2554d6dcede960a00fb))
- start pre-release 0.3.1 ([557efc3](https://github.com/Electivus/Apex-Log-Viewer/commit/557efc3ea9fef86617c0bd6edcab965aad8b3b8a))
- trigger release 0.2.1 ([7848c62](https://github.com/Electivus/Apex-Log-Viewer/commit/7848c62f2a2e5a2c7ba189b73077150cd31498fc))

## [0.3.1](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.2.1...v0.3.1) (2025-08-30)

### Miscellaneous Chores

- start pre-release 0.3.1 ([557efc3](https://github.com/Electivus/Apex-Log-Viewer/commit/557efc3ea9fef86617c0bd6edcab965aad8b3b8a))

## [0.2.1](https://github.com/Electivus/Apex-Log-Viewer/compare/v0.2.0...v0.2.1) (2025-08-30)

### Miscellaneous Chores

- trigger release 0.2.1 ([7848c62](https://github.com/Electivus/Apex-Log-Viewer/commit/7848c62f2a2e5a2c7ba189b73077150cd31498fc))

## Changelog

This file is maintained manually. Keep entries concise and follow Semantic Versioning.
