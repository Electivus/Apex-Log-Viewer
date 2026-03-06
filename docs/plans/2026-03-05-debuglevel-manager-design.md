# DebugLevel Manager Design

## Goal

Add real `DebugLevel` management to the existing Debug Flags panel so users can:

- create a `DebugLevel` from scratch,
- load a useful preset and customize it field by field,
- edit any existing `DebugLevel`,
- delete an existing `DebugLevel`,
- keep using the refreshed `DebugLevel` list to apply `USER_DEBUG` trace flags.

## Constraints

- Reuse the existing Debug Flags panel instead of creating a separate view.
- Keep the existing TraceFlag workflow intact.
- Support all editable `DebugLevel` fields exposed by the org query provided by the user:
  - `DeveloperName`
  - `Language`
  - `MasterLabel`
  - `Workflow`
  - `Validation`
  - `Callout`
  - `ApexCode`
  - `ApexProfiling`
  - `Visualforce`
  - `System`
  - `Database`
  - `Wave`
  - `Nba`
  - `DataAccess`
- Exclude read-only metadata fields from editing.
- Use real Tooling API CRUD operations against `DebugLevel`.

## UX

The Debug Flags panel keeps its current upper workflow:

1. select org,
2. search/select user,
3. choose a `DebugLevel`,
4. apply/remove the `USER_DEBUG` trace flag.

Below that workflow, add a dedicated `Debug Level Manager` section with:

- a selector for existing `DebugLevel` records,
- a `New` action that starts with an empty draft,
- a preset selector plus `Apply preset`,
- editable identity fields:
  - `DeveloperName`
  - `MasterLabel`
  - `Language`
- editable pickers for every log category field,
- actions:
  - `Save`
  - `Delete`
  - `Reset changes`

Behavior rules:

- Selecting an existing `DebugLevel` loads its current values into a draft form.
- `Apply preset` updates the draft only; it never saves automatically.
- `New` starts a new unsaved draft and clears the selected persisted record.
- `Reset changes` restores the draft to the last loaded record, or to the empty draft for a new item.
- After save/delete, the panel refreshes the full `DebugLevel` list and keeps the affected item selected when possible.
- Delete uses confirmation and surfaces Salesforce errors verbatim enough to explain cases like “record is still referenced by TraceFlag”.

## Data Model

Introduce a typed `DebugLevelRecord` shared model for the panel/webview flow:

- `id?: string`
- `developerName: string`
- `masterLabel: string`
- `language: string`
- `workflow: string`
- `validation: string`
- `callout: string`
- `apexCode: string`
- `apexProfiling: string`
- `visualforce: string`
- `system: string`
- `database: string`
- `wave: string`
- `nba: string`
- `dataAccess: string`

Also introduce:

- `DebugLevelPreset`
- `DebugLevelFieldLevel` union for the allowed log-level values
- `DebugLevelDraftState` shape on the webview side

## Presets

Ship curated presets as typed local constants so they can seed the draft predictably. The first delivery should include a small set of useful defaults such as:

- `Developer Focus`
- `Integration Troubleshooting`
- `Validation and Flow`
- `Performance and Database`

Presets are only defaults. The user can change every field before saving.

## Backend Changes

Extend the current `src/salesforce/traceflags.ts` responsibilities to cover `DebugLevel` CRUD because the file already owns debug-level lookup and trace-flag coupling.

Add:

- detailed `DebugLevel` list query,
- fetch by id/name helper,
- create function,
- update function,
- delete function,
- mapping helpers between Salesforce payloads and shared types,
- request-payload builder for create/update.

Refresh behavior:

- continue serving the simple list of names for existing consumers,
- add a richer list for the manager UI,
- after mutations, invalidate the debug-level cache before re-querying.

## Panel/Webview Changes

### Panel

Extend `DebugFlagsPanel` to:

- bootstrap detailed debug-level data and preset definitions,
- process new messages for:
  - selecting a manager item,
  - starting a new draft,
  - applying a preset to the draft,
  - saving a draft,
  - deleting a `DebugLevel`,
- refresh both the manager list and the existing trace-flag selector after mutations.

### Shared message contracts

Expand `src/shared/debugFlagsMessages.ts` and `src/shared/debugFlagsTypes.ts` with:

- detailed debug-level records,
- preset payloads,
- new manager actions,
- manager state sync messages.

### Webview

Extend `src/webview/debugFlags.tsx` to render:

- manager selector,
- preset selector,
- editable form,
- dirty/reset/save/delete interactions,
- notices/errors specific to debug-level CRUD.

The current trace-flag controls stay available and continue using the refreshed list of names.

## Validation and Error Handling

- `DeveloperName` and `MasterLabel` must be required before save.
- `Language` should default sensibly, but remain editable.
- Every log category field must be constrained to the allowed Salesforce enum values.
- Delete should require an explicit confirmation dialog from the extension host.
- Save should show clear success/error notices and preserve the current draft when a mutation fails.

## Testing Strategy

Follow TDD:

1. backend tests for mapping, CRUD requests, and cache invalidation,
2. panel behavior tests for new message handling and refresh flows,
3. webview tests for draft/preset/edit/save/delete behavior,
4. targeted build/lint/test verification.

## Non-Goals

- showing read-only audit metadata in the UI,
- bulk edit or bulk delete of multiple `DebugLevel` records,
- automatic deletion of dependent `TraceFlag` records,
- a separate dedicated `DebugLevel` view.
