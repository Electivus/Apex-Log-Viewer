# Dev Hub JWT implementation verification

Coordinator aggregation on 9 September 2026, before final readiness of PR #1097. The eight active decisions that declare verification have implementation evidence across the six delivery slices. DEC-008 remains an applicability-only scope decision; DEC-006 remains superseded.

This checkpoint authorizes the existing implementation task to finish its final-head gates and authorized integration. **#1079 and parent #1073 remain open.** Acceptance of the rotated credential still requires a complete opted-in workflow on the actual integrated `main` commit, receipt inspection and explicit retirement or retention reporting.

## Source and provenance

- Original final Planning checkpoint: `d6301c31287b315cc5929a6ce603a5c70eb11775`.
- Current reviewed source: `1dbd80ed5ff4d126838d4bc588ee7353741f0045`, tree `eb941f4eec07821e9ba6c057339e975f815d2721`.
- Current production baseline: `2cb2c941c8dd35297bb0ce8737e8c14ce9165d13` (#1096), with the same tree as its reviewed source `b6e178f55f12d78a3f2f2aa7ce1cd300fde9c812`.
- The coordinator uses Planning's ticket-evidence mode. The 54 repeatable verification records preserved by #1096 and all four #1079 implementation/fix records are carried verbatim with commit provenance. Already-read acceptance and actual workflow evidence supplement them. Historical pending/obsolete-runtime statements remain historical evidence; the later records below establish the current results.
- DEC-002 preserves its checkpointed opaque feasibility text and appends the generated records through the owner's legacy `coverage add` seam; the other seven decisions use aggregation JSON arrays. This preserves compatibility with the unchanged validator's append-only rule.
- The effort ref preserves the exact Planning ancestry and reviewed commits. Squash-main ancestry is verified separately; this document does not claim #1097 is integrated.

## Delivery evidence

| Slice | Observable evidence | Decisions |
| --- | --- | --- |
| [#1074](https://github.com/Electivus/Apex-Log-Viewer/issues/1074#issuecomment-5563378050) | Direct JavaScript and TypeScript paths passed selected-identity JWT, renewal, PlatformCLI signup, API access, independent export/import, preservation of caller state and scoped cleanup. Integrated in the effort at `abebd5d4d9cebe8273d156ea438daddfb0a1e623`. | DEC-001, DEC-003, DEC-005 |
| [#1075](https://github.com/Electivus/Apex-Log-Viewer/issues/1075#issuecomment-5564493478) | Six public pool commands and a real isolated pool passed bootstrap/prewarm/reconcile, independent acquisition/import/query, JWT heartbeat renewal, finalize/release, failure recovery and owned remote deletion. Integrated at `86b7e4eb7f33cd1949cd17cd2c7f4140fee768ca`. | DEC-001, DEC-003, DEC-005 |
| [#1076](https://github.com/Electivus/Apex-Log-Viewer/issues/1076#issuecomment-5565253152) | Actual Linux proxy-lab smoke passed JWT, renewal, PlatformCLI/API/import and owned deletion. Egress/proxy-auth/CA tests preserved TLS verification and corporate trust; actual-run owned input/state volumes were absent afterward. Integrated at `f268fee7fb5aa3e4ad4d98321e662b3e95a09b2b`. | DEC-001, DEC-003, DEC-005 |
| [#1077](https://github.com/Electivus/Apex-Log-Viewer/issues/1077#issuecomment-5576836820) | Exactly one owned dedicated identity/ECA; approved contact became the username. Salesforce Integration with its minimum API-only profile/PSL passed definition-mode scratch and pool behavior. Fresh complete grants and exclusive ECA policy were audited without runtime administrator permissions. Approved repository Actions Secrets and 365-day certificate were provisioned. Integrated at `48d0bc1c9b1b4395574f4422d275a0cc9cb49e17`. | DEC-002, DEC-004, DEC-007, DEC-009 |
| [#1078](https://github.com/Electivus/Apex-Log-Viewer/issues/1078#issuecomment-5584130789) | Actual integrated production CI and all seven real-org jobs passed. Six JS/TS receipts across Windows, Linux/MITM and macOS prove empty-state dedicated JWT, renewal, scratch API/export/import, kept-scratch usability and cleanup. The isolated pool/consumer receipt passed. macOS proved private encrypted homes and the supported isolated CLI runtime. | DEC-001, DEC-002, DEC-003, DEC-004, DEC-005, DEC-010 |
| [#1079 / PR #1097](https://github.com/Electivus/Apex-Log-Viewer/pull/1097) | Controlled active ECA/Secret rotation passed fresh dedicated JWT/API on 8 September. Public-command tests prove interruption/forward/rollback recovery and missing-key/input rejection. Current candidate evidence below proves the newly configured credential in CI; final integrated-main acceptance is pending. | DEC-001, DEC-004 |

## Production cutover already accepted

[Main CI 34214936040](https://github.com/Electivus/Apex-Log-Viewer/actions/runs/34214936040) and [opted-in production run 34214987399](https://github.com/Electivus/Apex-Log-Viewer/actions/runs/34214987399) passed at `2cb2c941c8dd35297bb0ce8737e8c14ce9165d13`. CLI 2.150.6 used Node 24.15.0 from `.nvmrc`, including the sanitized isolated macOS wrapper. The pool receipt records remote/local cleanup complete, no owned active scratch and no retained smoke resources. Telemetry validated 96 events, eight names and one query.

Qualifications: the production run passed on attempt 2 after one Azure query/gate-only retry for Service Temporarily Unavailable; the emitter was not repeated. Ubuntu UI had three flaky tests, Windows CLI one and Windows UI two, all passing within configured retries. Snapshot entitlement remains unproven under Integration, and older-owner cleanup retains its explicit transition procedure. No pool mode or runtime grants were broadened.

## Rotated-credential evidence and remaining integration gate

The active rotation updated only the owned certificate and private-key Secret; the other three JWT inputs, client identity, policies and runtime grants were preserved. Fresh candidate JWT/API passed at 16:01:33 UTC on 8 September, with Secret update at 16:01:35 UTC. The certificate expires on 8 September 2027. Rotation-only snapshots retained eight scratches, four pools and 72 slots with identical selected configuration/lease hashes. Recovery and ownership details are in [DEVHUB_ROTATION.md](../../DEVHUB_ROTATION.md).

At the current source tree:

- [Native PR Real Org 34368176349](https://github.com/Electivus/Apex-Log-Viewer/actions/runs/34368176349) passed all seven jobs on attempt 1, alongside [CI 34368176285](https://github.com/Electivus/Apex-Log-Viewer/actions/runs/34368176285); all 20 PR checks succeeded. Its synthetic merge `a1496dbe63d323fd6a03d8be163293ccf24867ca` has exactly the current source tree. Telemetry validated 111 events across eight names on one query. PR lifecycle opt-ins were skipped, so this run alone does not attest those smokes.
- [Explicit candidate run 34368450409](https://github.com/Electivus/Apex-Log-Viewer/actions/runs/34368450409) **failed overall** with `AADSTS700213`: the existing Azure federation does not accept the feature-branch subject. It was not rerun or represented as green. Its completed steps produced six JS/TS lifecycle receipts across Windows, Linux/MITM and macOS, all passing retry 0, including empty-state JWT without a Dev Hub refresh token, renewal, caller-state preservation, scratch API and independent import/query, keep-org usability and scoped cleanup. macOS additionally proved private encrypted homes and independent encryption keys.
- The candidate's isolated Linux/MITM pool receipt proves independent consumer import/query, JWT renewal, release/recovery, deleted owned signup, remote/local cleanup complete and `retainedResources: []`. Unrelated active counts changed from ten to eight during concurrent consumption; this is not an inventory-equality claim. Separate before/after snapshots retained eight scratches, four pools and 72 slots with the same pool configuration hash, while scratch/slot hashes changed during consumers.
- Native PR Ubuntu UI had one flaky test (retry 2) and Windows UI two (retry 1). Candidate Windows UI and macOS IntelliJ each had one flaky test (retry 1). Candidate Ubuntu UI and telemetry were skipped after the Azure failure; the tree-identical native PR supplies their successful production-gate evidence.

On 9 September at 16:20 UTC the coordinator accepted these complementary premerge receipts under the user's continuing authorization. No Azure federation, workflow, required-check or retry-limit changes are part of that decision. The candidate failure remains a failure. All final-head PR gates must pass again after the Planning-only update. After authorized squash, a complete opted-in run on the actual integrated `main` SHA and inspected receipts are mandatory before closing #1079, closing #1073 or retiring recovery material.

## Validation, review and retained resources

The #1079 implementation passed the required Windows-native local suites, type-check, lint, build, 145 E2E utility checks, three stable integration checks, provenance and 1,297 registry signatures. The Standards/Spec initial assessments share frozen base `ded86b9e306e676dc93897e5b3480379681fa567` and head `a2b39eb9319b93316799ccf3463541b31db10186`. ST-001 was corrected at the current source and all 134 public identity-command tests passed. Initial rounds: one per axis; consolidated fix batches: one; follow-ups: zero. This Planning-only update does not reopen the bounded review.

Current key/input references, identity journal and prior/candidate recovery copies remain private until final production proof. Earlier automatic-review denials for experiment/bootstrap cleanup remain binding and those private keys are not proven deleted. Disabled temporary apps, intentionally retained permanent assets, older denied residue and this rotation's material are distinct inventories. The unused legacy Dev Hub auth-URL Secret remains owner-controlled. No personal token was revoked, shared pool reset or certificate reminder installed.

## Planning context

- Format: v1
- Repository: Electivus/Apex-Log-Viewer
- Effort: devhub-jwt
- Decision ledger: `docs/planning/devhub-jwt/decision-ledger.md`
- Planning checkpoint: d6301c31287b315cc5929a6ce603a5c70eb11775
- Decisions: DEC-001, DEC-002, DEC-003, DEC-004, DEC-005, DEC-007, DEC-008, DEC-009, DEC-010
