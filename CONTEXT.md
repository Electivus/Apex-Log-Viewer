# Apex Log Viewer

This context covers how Apex logs move from Salesforce or an existing local copy into dependable local use across the product surfaces.

## Language

**Apex Log Lifecycle**:
The end-to-end journey of an Apex log body from acquisition or cache discovery through canonical local materialization and subsequent local use.
_Avoid_: log storage, log download — when referring to the whole lifecycle

**Apex Log Viewer Agent Skill**:
The portable `apex-log-viewer-cli` instruction package published from the repository's neutral `skills/` catalog and installed through the cross-agent `skills` CLI.
_Avoid_: vendor-specific skill names — when referring to the canonical package

**Parsed Log Viewer**:
The Apex Log Viewer-owned structured interpretation of a dependable Apex log, providing investigation perspectives beyond raw-text or tree-only presentation.
_Avoid_: replay debugger, Illuminated Cloud viewer — when referring to the Apex Log Viewer-owned presentation

**Replay Handoff**:
The optional transfer of a dependable raw Apex log from Apex Log Viewer to Illuminated Cloud 2 for analysis and offline replay; Apex Log Viewer does not own or start replay debugging.
_Avoid_: IntelliJ Replay, direct replay — when referring to a capability owned by Apex Log Viewer

**Unified Log Search**:
One progressive discovery workflow across a stable Apex log catalog snapshot and dependable local log bodies. Bodies acquired while searching join the normal Apex Log Lifecycle rather than a temporary search-only cache.
_Avoid_: metadata filter, local search — when referring to the combined behavior

**Scratch Org Pool**:
The reusable collection of Salesforce test environments available to Apex Log Viewer validation, with each environment assigned through a time-limited lease.
_Avoid_: org cache, runner pool — when referring to this managed collection

**Dev Hub Automation Identity**:
The dedicated Salesforce user responsible for managing the Scratch Org Pool and its test environments on behalf of automated validation.
_Avoid_: scratch user, developer account — when referring to the pool-management identity
