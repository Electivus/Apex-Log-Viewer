------------------------------ MODULE Witness ------------------------------
EXTENDS CaptureLease

DeadOwner(t) == t /= None /\ minter[t] /= None /\ ~alive[minter[t]]

NeverDeadHolderAndDeadElector == ~(DeadOwner(lease) /\ DeadOwner(MarkerAt(<<lease>>)))
NeverOrphanDeadElector ==
  ~(lease = None /\ \E m \in markers : Len(m[1]) = 1 /\ DeadOwner(m[1][1]) /\ DeadOwner(m[2]))

NeverPassesTwoDeadElectors == \A p \in Procs : ~(pc[p] = "unlinkPassedMarker" /\ done[p] >= 1)
NeverFindsLeaseGoneAfterPassing ==
  [][\A p \in Procs : ~(ElectedReadLease(p) /\ lease /= rec[p] /\ Len(chain[p]) > 1)]_vars

NeverNoticesLoss == [][\A p \in Procs : ~FenceSeesLoss(p)]_vars
NeverReleasesAfterLoss == [][\A p \in Procs : ~(ReleaseRead(p) /\ lease /= tok[p])]_vars
=============================================================================
