--------------------------- MODULE CaptureLease ---------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Procs,
  MaxTokens,
  MaxCrashes,
  Leftovers,
  UserDeletes

None == 0
Tokens == 1..MaxTokens

(* Every combination of those two files is a state that two crashes leave:  *)
(* Reach.cfg shows it.                                                       *)
DeadHolder == 98
DeadElector == 99
Pids == Procs \cup (IF Leftovers THEN {DeadHolder, DeadElector} ELSE {})
ASSUME Procs \subseteq Nat \ {None, DeadHolder, DeadElector}
ASSUME Leftovers => MaxTokens >= 2

VARIABLES
  lease,
  markers,
  minter,
  minted,
  alive,
  crashes,
  pc,
  tok,
  rec,
  mrec,
  chain,
  done

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

HolderDead(t) == ~alive[minter[t]]

MarkerName(c) == IF Len(c) = 1 THEN c ELSE <<Head(c), c[Len(c)]>>

MarkerAt(name) == IF \E m \in markers : m[1] = name THEN (CHOOSE m \in markers : m[1] = name)[2] ELSE None
WithMarker(name, elector) == {m \in markers : m[1] /= name} \cup {<<name, elector>>}
WithoutMarker(name) == {m \in markers : m[1] /= name}

Goto(p, where) == pc' = [pc EXCEPT ![p] = where]
At(p, where) == alive[p] /\ pc[p] = where

AfterElection(p) == IF Len(chain[p]) > 1 THEN "unlinkPassedMarker" ELSE "unlinkOwnMarker"

StartAttempt(p) ==
  /\ At(p, "idle")
  /\ minted < MaxTokens
  /\ minted' = minted + 1
  /\ minter' = [minter EXCEPT ![minted + 1] = p]
  /\ tok' = [tok EXCEPT ![p] = minted + 1]
  /\ Goto(p, "createLease")
  /\ UNCHANGED <<lease, markers, alive, crashes, rec, mrec, chain, done>>

CreateLease(p) ==
  /\ At(p, "createLease")
  /\ IF lease = None
       THEN /\ lease' = tok[p]
            /\ Goto(p, "capturing")
       ELSE /\ UNCHANGED lease
            /\ Goto(p, "readLease")
  /\ UNCHANGED <<markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

ReadLease(p) ==
  /\ At(p, "readLease")
  /\ rec' = [rec EXCEPT ![p] = lease]
  /\ Goto(p, IF lease = None THEN "createLease" ELSE "judgeHolder")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, mrec, chain, done>>

JudgeHolder(p) ==
  /\ At(p, "judgeHolder")
  /\ IF HolderDead(rec[p])
       THEN /\ chain' = [chain EXCEPT ![p] = <<rec[p]>>]
            /\ done' = [done EXCEPT ![p] = 0]
            /\ Goto(p, "createMarker")
       ELSE /\ UNCHANGED <<chain, done>>
            /\ Goto(p, "idle")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec>>

CreateMarker(p) ==
  /\ At(p, "createMarker")
  /\ IF MarkerAt(MarkerName(chain[p])) = None
       THEN /\ markers' = WithMarker(MarkerName(chain[p]), tok[p])
            /\ Goto(p, "electedReadLease")
       ELSE /\ UNCHANGED markers
            /\ Goto(p, "readMarker")
  /\ UNCHANGED <<lease, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

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

UnlinkPassedMarker(p) ==
  /\ At(p, "unlinkPassedMarker")
  /\ markers' = WithoutMarker(MarkerName(SubSeq(chain[p], 1, done[p] + 1)))
  /\ done' = [done EXCEPT ![p] = done[p] + 1]
  /\ Goto(p, IF done[p] + 1 < Len(chain[p]) - 1 THEN "unlinkPassedMarker" ELSE "unlinkOwnMarker")
  /\ UNCHANGED <<lease, minter, minted, alive, crashes, tok, rec, mrec, chain>>

\* Elected: `await unlinkIfPresent(marker); return 'retry';` removes whatever the name holds now.
UnlinkOwnMarker(p) ==
  /\ At(p, "unlinkOwnMarker")
  /\ markers' = WithoutMarker(MarkerName(chain[p]))
  /\ Goto(p, "createLease")
  /\ UNCHANGED <<lease, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

ReadMarker(p) ==
  /\ At(p, "readMarker")
  /\ mrec' = [mrec EXCEPT ![p] = MarkerAt(MarkerName(chain[p]))]
  /\ Goto(p, IF MarkerAt(MarkerName(chain[p])) = None THEN "createLease" ELSE "judgeElector")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, chain, done>>

JudgeElector(p) ==
  /\ At(p, "judgeElector")
  /\ IF HolderDead(mrec[p])
       THEN /\ chain' = [chain EXCEPT ![p] = Append(chain[p], mrec[p])]
            /\ Goto(p, "createMarker")
       ELSE /\ UNCHANGED chain
            /\ Goto(p, "waitLease")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, done>>

WaitSeesChange(p) ==
  /\ At(p, "waitLease")
  /\ lease /= rec[p]
  /\ Goto(p, "createLease")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

WaitTimesOut(p) ==
  /\ At(p, "waitLease")
  /\ lease = rec[p]
  /\ Goto(p, "idle")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

FenceSeesLoss(p) ==
  /\ At(p, "capturing")
  /\ lease /= tok[p]
  /\ Goto(p, "releaseRead")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

Finish(p) ==
  /\ At(p, "capturing")
  /\ Goto(p, "releaseRead")
  /\ UNCHANGED <<lease, markers, minter, minted, alive, crashes, tok, rec, mrec, chain, done>>

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

Crash(p) ==
  /\ alive[p]
  /\ crashes < MaxCrashes
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<lease, markers, minter, minted, pc, tok, rec, mrec, chain, done>>

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

Capturing == {p \in Procs : alive[p] /\ pc[p] = "capturing"}

OneCapturer == Cardinality(Capturing) <= 1

NoLiveTheft == \A p \in Capturing : lease = tok[p]

=============================================================================
