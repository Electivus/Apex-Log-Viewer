# Apex Log Viewer

This context covers how Apex logs move from Salesforce or an existing local copy into dependable local use across the product surfaces.

## Language

**Apex Log Lifecycle**:
The end-to-end journey of an Apex log body from acquisition or cache discovery through canonical local materialization and subsequent local use.
_Avoid_: log storage, log download — when referring to the whole lifecycle

**Apex Log Viewer Agent Skill**:
The portable `apex-log-viewer-cli` instruction package published from the repository's neutral `skills/` catalog and installed through the cross-agent `skills` CLI.
_Avoid_: vendor-specific skill names — when referring to the canonical package

**Replay Handoff**:
The IntelliJ surface ends after opening the dependable raw Apex log in the editor; replay debugging belongs to Illuminated Cloud 2.
_Avoid_: IntelliJ Replay — when referring to a capability owned by Apex Log Viewer
