------------------------------ MODULE Witness ------------------------------
(* Paths that must exist. Each rule here claims that something never       *)
(* happens; TLC breaking it is the shortest path to it, and check.mjs       *)
(* replays that path on the real code. The expected result is a break.     *)
EXTENDS CaptureLease

DeadOwner(t) == t /= None /\ minter[t] /= None /\ ~alive[minter[t]]

\* Reach.cfg: the Leftovers start of Leftovers.cfg comes from clean files and two crashes.
\* The lease names a dead holder and its reclaim marker names a dead elector.
NeverDeadHolderAndDeadElector == ~(DeadOwner(lease) /\ DeadOwner(MarkerAt(<<lease>>)))
\* The lease is gone and a dead holder's reclaim marker names a dead elector.
NeverOrphanDeadElector ==
  ~(lease = None /\ \E m \in markers : Len(m[1]) = 1 /\ DeadOwner(m[1][1]) /\ DeadOwner(m[2]))

\* Chain.cfg: an elector passes over two dead electors and unlinks both of their markers.
NeverPassesTwoDeadElectors == \A p \in Procs : ~(pc[p] = "unlinkPassedMarker" /\ done[p] >= 1)
\* Chain.cfg: an elector that passed over a dead elector finds the dead record already gone,
\* because another elector of the same chain finished first.
NeverFindsLeaseGoneAfterPassing ==
  [][\A p \in Procs : ~(ElectedReadLease(p) /\ lease /= rec[p] /\ Len(chain[p]) > 1)]_vars

\* Fence.cfg: a user deletes the lease of a live holder, another process takes it, and the
\* holder finds out at its next writer.advance (LeaseLostError).
NeverNoticesLoss == [][\A p \in Procs : ~FenceSeesLoss(p)]_vars
\* A release that finds another token leaves that file alone.
NeverReleasesAfterLoss == [][\A p \in Procs : ~(ReleaseRead(p) /\ lease /= tok[p])]_vars
=============================================================================
