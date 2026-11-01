--------------------------- MODULE CaptureLease ---------------------------
(***************************************************************************)
(* The capture lease of the Custom Logs event store: one process per event  *)
(* object subscribes to its platform event channel.                         *)
(*                                                                          *)
(*   packages/core/src/localStore/workspaceFs.ts                            *)
(*     tryAcquireLease, reclaimDeadLease, Lease.stillHeld, Lease.release    *)
(*   packages/core/src/customLogs/events/store.ts                           *)
(*     openWriter (acquire), writer.advance (fence), writer.release         *)
(*   packages/core/src/customLogs/events/capture.ts                         *)
(*     acquire (standby retry), epoch (LeaseLostError -> release, standby)  *)
(*                                                                          *)
(* One action is one awaited file system call (or one process.kill(pid,0))  *)
(* in that code. Another process can act between any two of them. Every    *)
(* process runs on the same host; a process can die at any point and its   *)
(* files stay. A token stands for the whole lease record: tokens are random *)
(* and unique, so two records are equal exactly when their tokens are.      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Procs,       \* processes that capture the same event object (VS Code windows, sf commands)
  MaxTokens,   \* bound: tryAcquireLease calls in the whole run (each call mints one token)
  MaxCrashes,  \* bound: processes in Procs that die
  Leftovers,   \* TRUE: the run starts on files that two dead processes left (see Init)
  UserDeletes  \* TRUE: the user may delete capture.lease at any time (Fence.cfg)

None == 0
Tokens == 1..MaxTokens

(* With Leftovers, two processes died before the run: DeadHolder held the  *)
(* lease with token 1, and DeadElector died inside reclaimDeadLease after  *)
(* it created capture.lease.reclaim-1 with token 2. Every combination of    *)
(* those two files is a state that two crashes leave: Reach.cfg shows it.  *)
DeadHolder == 98
DeadElector == 99
Pids == Procs \cup (IF Leftovers THEN {DeadHolder, DeadElector} ELSE {})
ASSUME Procs \subseteq Nat \ {None, DeadHolder, DeadElector}
ASSUME Leftovers => MaxTokens >= 2

VARIABLES
  lease,    \* the token capture.lease names; None when the file is absent
  markers,  \* {<<name, elector>>}: capture.lease.reclaim-<name> names token `elector`;
            \* name <<t>> is the file reclaim-<t>, <<t, e>> is reclaim-<t>-<e>
  minter,   \* minter[t]: the process (pid) whose tryAcquireLease call minted token t
  minted,   \* how many tokens exist
  alive,    \* alive[p]: process.kill(pid, 0) succeeds for p
  crashes,
  pc,       \* where each process is in the code
  tok,      \* tok[p]: the token of p's current tryAcquireLease call (`owner.token`)
  rec,      \* rec[p]: the lease record p judged (`record`, `deadRecord`)
  mrec,     \* mrec[p]: the marker record p read (`markerRecord`)
  chain,    \* chain[p]: the dead holder, then each dead elector p passed over; Name(chain[p]) is `marker`
  done      \* done[p]: how many passed-over markers p has unlinked

vars == <<lease, markers, minter, minted, alive, crashes, pc, tok, rec, mrec, chain, done>>

PCs == {"idle", "createLease", "readLease", "judgeHolder",
        "createMarker", "electedReadLease", "electedUnlinkLease", "unlinkPassedMarker", "unlinkOwnMarker",
        "readMarker", "judgeElector", "waitLease",
        "capturing", "releaseRead", "releaseUnlink"}

TypeOK ==
  /\ lease \in Tokens \cup {None}
  /\ \A m \in markers : m[1] \in Seq(Tokens) /\ m[2] \in Tokens
  /\ minter \in [Tokens -> Pids \cup {None}]
  /\ minted \in 0..MaxTokens
  /\ alive \in [Pids -> BOOLEAN]
  /\ crashes \in 0..MaxCrashes
  /\ pc \in [Procs -> PCs]
  /\ tok \in [Procs -> Tokens \cup {None}]
  /\ rec \in [Procs -> Tokens \cup {None}]
  /\ mrec \in [Procs -> Tokens \cup {None}]
  /\ chain \in [Procs -> Seq(Tokens)]
  /\ done \in [Procs -> Nat]

Init ==
  /\ IF Leftovers
       THEN /\ lease \in {None, 1}
            /\ markers \in {{}, {<<<<1>>, 2>>}}
            /\ minter = [t \in Tokens |-> CASE t = 1 -> DeadHolder [] t = 2 -> DeadElector [] OTHER -> None]
            /\ minted = 2
       ELSE /\ lease = None
            /\ markers = {}
            /\ minter = [t \in Tokens |-> None]
            /\ minted = 0
  /\ alive = [p \in Pids |-> p \in Procs]
  /\ crashes = 0
  /\ pc = [p \in Procs |-> "idle"]
  /\ tok = [p \in Procs |-> None]
  /\ rec = [p \in Procs |-> None]
  /\ mrec = [p \in Procs |-> None]
  /\ chain = [p \in Procs |-> <<>>]
  /\ done = [p \in Procs |-> 0]

\* judgeLease(owner, here): 'reclaim' only when the record's pid is dead on this host.
HolderDead(t) == ~alive[minter[t]]

\* The marker a chain elects on: `firstMarker`, or `${firstMarker}-${elector.token}` after passing over
\* the dead elector named last. Each prefix of chain[p] names one of p's `passedOver` markers.
Name(c) == IF Len(c) = 1 THEN c ELSE <<Head(c), c[Len(c)]>>

\* The elector token a marker name holds, or None when the file is absent.
MarkerAt(name) == IF \E m \in markers : m[1] = name THEN (CHOOSE m \in markers : m[1] = name)[2] ELSE None
WithMarker(name, elector) == {m \in markers : m[1] /= name} \cup {<<name, elector>>}
WithoutMarker(name) == {m \in markers : m[1] /= name}

Goto(p, where) == pc' = [pc EXCEPT ![p] = where]
At(p, where) == alive[p] /\ pc[p] = where

\* After the elected branch: the passed-over markers, if any, then p's own.
AfterElection(p) == IF Len(chain[p]) > 1 THEN "unlinkPassedMarker" ELSE "unlinkOwnMarker"

\* capture.ts acquire -> store.ts openWriter -> tryAcquireLease: a fresh owner record.
\* A run's first attempt and every standby poll (STANDBY_POLL_MS) after `heldBy` or a lost lease.
StartAttempt(p) ==
  /\ At(p, "idle")
  /\ minted < MaxTokens
  /\ minted' = minted + 1
  /\ minter' = [minter EXCEPT ![minted + 1] = p]
  /\ tok' = [tok EXCEPT ![p] = minted + 1]
  /\ Goto(p, "createLease")
  /\ UNCHANGED <<lease, markers, alive, crashes, rec, mrec, chain, done>>

\* `if (await createIfAbsent(leasePath, serialized)) return { acquired: lease };` (fs.link of a temp file)
CreateLease(p) ==
  /\ At(p, "createLease")
  /\ IF lease = None
       THEN /\ lease' = tok[p]
            /\ Goto(p, "capturing")
       ELSE /\ UNCHANGED lease
            /\ Goto(p, "readLease")
  /\ UNCHANGED <<markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* `const record = await readSmallFile(leasePath); if (record === undefined) continue;`
ReadLease(p) ==
  /\ At(p, "readLease")
  /\ rec' = [rec EXCEPT ![p] = lease]
  /\ Goto(p, IF lease = None THEN "createLease" ELSE "judgeHolder")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, mrec, chain, done>>

\* `if (judgeLease(holder, here) === 'held') return { heldBy: holder };` else reclaimDeadLease,
\* whose first election runs on `${leasePath}.reclaim-${deadHolder.token}`.
JudgeHolder(p) ==
  /\ At(p, "judgeHolder")
  /\ IF HolderDead(rec[p])
       THEN /\ chain' = [chain EXCEPT ![p] = <<rec[p]>>]
            /\ done' = [done EXCEPT ![p] = 0]
            /\ Goto(p, "createMarker")
       ELSE /\ UNCHANGED <<chain, done>>
            /\ Goto(p, "idle")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec>>

\* `if (await createIfAbsent(marker, electorRecord))`
CreateMarker(p) ==
  /\ At(p, "createMarker")
  /\ IF MarkerAt(Name(chain[p])) = None
       THEN /\ markers' = WithMarker(Name(chain[p]), tok[p])
            /\ Goto(p, "electedReadLease")
       ELSE /\ UNCHANGED markers
            /\ Goto(p, "readMarker")
  /\ UNCHANGED <<lease, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* Elected: `if ((await readSmallFile(leasePath)) === deadRecord) ...`
ElectedReadLease(p) ==
  /\ At(p, "electedReadLease")
  /\ Goto(p, IF lease = rec[p] THEN "electedUnlinkLease" ELSE AfterElection(p))
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* Elected: `... await unlinkIfPresent(leasePath);` removes whatever the name holds now.
ElectedUnlinkLease(p) ==
  /\ At(p, "electedUnlinkLease")
  /\ lease' = None
  /\ Goto(p, AfterElection(p))
  /\ UNCHANGED <<markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* Elected: `for (const settled of passedOver) await unlinkIfPresent(settled);`, shortest name first.
UnlinkPassedMarker(p) ==
  /\ At(p, "unlinkPassedMarker")
  /\ markers' = WithoutMarker(Name(SubSeq(chain[p], 1, done[p] + 1)))
  /\ done' = [done EXCEPT ![p] = done[p] + 1]
  /\ Goto(p, IF done[p] + 1 < Len(chain[p]) - 1 THEN "unlinkPassedMarker" ELSE "unlinkOwnMarker")
  /\ UNCHANGED <<lease, minter, minted, alive, crashes, tok, rec, mrec, chain>>

\* Elected: `await unlinkIfPresent(marker); return 'retry';` removes whatever the name holds now.
UnlinkOwnMarker(p) ==
  /\ At(p, "unlinkOwnMarker")
  /\ markers' = WithoutMarker(Name(chain[p]))
  /\ Goto(p, "createLease")
  /\ UNCHANGED <<lease, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* Not elected: `const markerRecord = await readSmallFile(marker); if (markerRecord === undefined) return 'retry';`
ReadMarker(p) ==
  /\ At(p, "readMarker")
  /\ mrec' = [mrec EXCEPT ![p] = MarkerAt(Name(chain[p]))]
  /\ Goto(p, IF MarkerAt(Name(chain[p])) = None THEN "createLease" ELSE "judgeElector")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, chain, done>>

\* `if (!elector || judgeLease(elector, here) !== 'reclaim') break;` waits for a live elector.
\* A dead elector's marker is passed over, never unlinked here: `passedOver.push(marker)`, then
\* `marker = ${firstMarker}-${elector.token}`, and the election runs again on that new name.
JudgeElector(p) ==
  /\ At(p, "judgeElector")
  /\ IF HolderDead(mrec[p])
       THEN /\ chain' = [chain EXCEPT ![p] = Append(chain[p], mrec[p])]
            /\ Goto(p, "createMarker")
       ELSE /\ UNCHANGED chain
            /\ Goto(p, "waitLease")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, done>>

\* Live elector: `while ((await readSmallFile(leasePath)) === deadRecord)`; a read that finds
\* another record returns 'retry'. A read that still finds the dead record polls again (no change).
WaitSeesChange(p) ==
  /\ At(p, "waitLease")
  /\ lease /= rec[p]
  /\ Goto(p, "createLease")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* `if (Date.now() >= deadline) return 'held';` after a read that still finds the dead record:
\* LEASE_RECLAIM_SETTLE_MS is abstracted, so the deadline can pass at any such read.
WaitTimesOut(p) ==
  /\ At(p, "waitLease")
  /\ lease = rec[p]
  /\ Goto(p, "idle")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* writer.advance: `if (!(await lease.stillHeld())) throw new LeaseLostError();` -> epoch releases, stands by.
\* An advance that finds its own token changes nothing, so only the losing read is a step.
FenceSeesLoss(p) ==
  /\ At(p, "capturing")
  /\ lease /= tok[p]
  /\ Goto(p, "releaseRead")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* The run ends (last watcher leaves, budget, needsInitial, a failure): epoch -> writer.release().
Finish(p) ==
  /\ At(p, "capturing")
  /\ Goto(p, "releaseRead")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* Lease.release: `if ((await tokenOnDisk()) === owner.token) ...`
ReleaseRead(p) ==
  /\ At(p, "releaseRead")
  /\ Goto(p, IF lease = tok[p] THEN "releaseUnlink" ELSE "idle")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* Lease.release: `... await unlinkIfPresent(leasePath);` removes whatever the name holds now.
ReleaseUnlink(p) ==
  /\ At(p, "releaseUnlink")
  /\ lease' = None
  /\ Goto(p, "idle")
  /\ UNCHANGED <<markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

\* The process dies anywhere (window closed, SIGKILL, SIGTERM on `sf ... --follow`). Its files stay.
Crash(p) ==
  /\ alive[p]
  /\ crashes < MaxCrashes
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<lease, markers, minter, minted, pc, tok, rec, mrec, chain, done>>

\* docs/CUSTOM_LOGS.md tells the user to delete capture.lease when its holder is gone. A user who
\* deletes it while the holder lives is what the stillHeld() fence is for (Fence.cfg only).
UserDeletesLease ==
  /\ UserDeletes
  /\ lease /= None
  /\ lease' = None
  /\ UNCHANGED <<markers, minter, minted, alive, crashes, pc, tok, rec, mrec, chain, done>>

Next ==
  \/ UserDeletesLease
  \/ \E p \in Procs :
       \/ StartAttempt(p)
       \/ CreateLease(p) \/ ReadLease(p) \/ JudgeHolder(p)
       \/ CreateMarker(p) \/ ElectedReadLease(p) \/ ElectedUnlinkLease(p)
       \/ UnlinkPassedMarker(p) \/ UnlinkOwnMarker(p)
       \/ ReadMarker(p) \/ JudgeElector(p)
       \/ WaitSeesChange(p) \/ WaitTimesOut(p)
       \/ FenceSeesLoss(p) \/ Finish(p)
       \/ ReleaseRead(p) \/ ReleaseUnlink(p)
       \/ Crash(p)

Spec == Init /\ [][Next]_vars

\* A process subscribes from the moment it holds the lease until it releases it.
Capturing == {p \in Procs : alive[p] /\ pc[p] = "capturing"}

(* RULE OneCapturer. At most one process captures an event object at a time,  *)
(* so the org sees one subscription and delivers each event once              *)
(* (docs/CUSTOM_LOGS.md, "Standby and the capture lease").                    *)
OneCapturer == Cardinality(Capturing) <= 1

(* RULE NoLiveTheft. Core never takes the lease from a process that is still   *)
(* alive: while a live process captures, capture.lease names it.              *)
NoLiveTheft == \A p \in Capturing : lease = tok[p]

=============================================================================
