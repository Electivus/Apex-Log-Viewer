# Issue tracker: Linear

Issues and PRDs for this repository live in the Electivus Linear workspace. Use the connected Linear app for all tracker operations.

## Repository scope

- **Team:** `Electivus` (`ELE`)
- **Project:** [`Apex Log Viewer`](https://linear.app/electivus/project/apex-log-viewer-2c6eeb57f135)
- **Repository:** `Electivus/Apex-Log-Viewer`

Unless a workflow explicitly says otherwise, create repository work in the `Electivus` team and assign it to the `Apex Log Viewer` project.

## Conventions

- **Read before writing:** Resolve the team, project, issue, labels, workflow states, and relations with the Linear read/list operations before creating or updating data.
- **Create an issue:** Create it in team `Electivus` and project `Apex Log Viewer`, with a Markdown description containing the complete implementation or decision context.
- **Read an issue:** Fetch it by its full Linear identifier, such as `ELE-123`, including relations; fetch comments when discussion history matters.
- **List issues:** Scope queries to team `Electivus` and, for repository work, project `Apex Log Viewer`. Apply status, label, assignee, cycle, and priority filters as required by the workflow.
- **Update an issue:** Preserve fields outside the requested change. Use Linear's native assignee, project, parent/sub-issue, blocker, related-issue, label, priority, cycle, estimate, due-date, and workflow-state fields.
- **Comment on an issue:** Add a Linear comment in Markdown. Do not duplicate information already present in the issue description unless the comment records a decision or status transition.
- **Apply or remove labels:** Use the exact strings in `docs/agents/triage-labels.md`. Resolve labels before mutation and create a missing canonical label as a team-scoped label only when the workflow requires it.
- **Close or cancel:** Resolve the current workflow states for team `Electivus`, then move the issue to the appropriate completed or canceled state. Do not assume that a state name is globally available.
- **Identifiers:** Use full identifiers such as `ELE-123` in documentation and cross-references; do not use ambiguous bare numbers.

## Pull requests as a triage surface

**PRs as a request surface: no.** Pull requests remain in GitHub and are not automatically mirrored into Linear. Only create or update a Linear issue for a pull request when a workflow or maintainer explicitly requests it.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team `Electivus` and project `Apex Log Viewer`.

## When a skill says "fetch the relevant ticket"

Fetch the Linear issue by its full identifier, include its relations, and read its comments when they carry requirements or decisions.

## Wayfinding operations

Used by `$mattpocock-skills:wayfinder`. The **map** is one Linear issue with **child** issues as tickets.

- **Map:** Create one issue in project `Apex Log Viewer`, labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket:** Create a sub-issue whose parent is the map. Label it `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). Once claimed, assign it to the driving developer.
- **Blocking:** Use Linear's native `blocked by` / `blocks` issue relations. A ticket is unblocked only when every blocker is completed or canceled.
- **Frontier query:** List the map's open children, exclude issues with unresolved blockers or an assignee, and select the first child in map order.
- **Claim:** Assign the selected issue to the current user; this is the session's first tracker write.
- **Resolve:** Comment with the answer or delivery evidence, move the issue to the appropriate completed state, and add the resulting context pointer to the map's Decisions-so-far section.
