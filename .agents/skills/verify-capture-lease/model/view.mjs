// The view module /pstack:statechart takes for CaptureLease.tla: one region per process and one
// for the files on disk, in the words of someone who runs two VS Code windows on one project.
const DEAD_HOLDER = 98;
const DEAD_ELECTOR = 99;

const PROCESS = {
  idle: 'Standing by',
  createLease: 'Trying the lease',
  readLease: 'Trying the lease',
  judgeHolder: 'Trying the lease',
  createMarker: 'Reclaiming a dead holder',
  readMarker: 'Reclaiming a dead holder',
  judgeElector: 'Reclaiming a dead holder',
  waitLease: 'Waiting for another reclaimer',
  electedReadLease: 'Elected: removing the dead lease',
  electedUnlinkLease: 'Elected: removing the dead lease',
  unlinkPassedMarker: 'Elected: removing the dead lease',
  unlinkOwnMarker: 'Elected: removing the dead lease',
  capturing: 'Capturing',
  releaseRead: 'Giving the lease back',
  releaseUnlink: 'Giving the lease back'
};

const procsOf = vars => Object.keys(vars.pc).map(Number);

function ownerName(vars, token) {
  if (token === 0 || token === undefined) return 'nobody';
  const pid = vars.minter[token];
  if (pid === DEAD_HOLDER) return 'the dead holder';
  if (pid === DEAD_ELECTOR) return 'the dead reclaimer';
  return `window ${pid}${vars.alive[pid] ? '' : ' (dead)'}`;
}

// A marker is <<name, elector>>; name <<t>> is the first marker of a dead holder, <<t, e>> the
// marker of the election that passed over the dead reclaimer e.
const markerLabel = (vars, marker) =>
  `${Object.keys(marker[1]).length === 1 ? 'Reclaim marker' : 'Next reclaim marker'} names ${ownerName(vars, marker[2])}`;

export const title = 'Capture lease: two windows start on files left by two dead processes';

export function state(vars) {
  const regions = {};
  for (const p of procsOf(vars)) regions[`Window ${p}`] = vars.alive[p] ? PROCESS[vars.pc[p]] : 'Dead';
  regions['capture.lease'] = vars.lease === 0 ? 'Absent' : `Names ${ownerName(vars, vars.lease)}`;
  const markers = vars.markers.map(marker => markerLabel(vars, marker)).sort();
  regions['Reclaim markers'] = markers.length === 0 ? 'None' : markers.join(', ');
  return regions;
}

const NOBODY = 'Nobody captures';
const ONE = 'One window captures';
const STOLEN = 'A window captures without its lease';
const TWO = 'Two windows capture';

export function group(vars) {
  const capturing = procsOf(vars).filter(p => vars.alive[p] && vars.pc[p] === 'capturing');
  if (capturing.length > 1) return TWO;
  if (capturing.some(p => vars.lease !== vars.tok[p])) return STOLEN;
  return capturing.length === 1 ? ONE : NOBODY;
}

export const colors = { [NOBODY]: 'blue', [ONE]: 'teal', [STOLEN]: 'orange', [TWO]: 'pink' };

const STEP = {
  UserDeletesLease: () => 'you delete capture.lease',
  StartAttempt: p => `window ${p} starts a capture`,
  CreateLease: (p, from, to) =>
    to.pc[p] === 'capturing' ? `window ${p} creates capture.lease` : `window ${p} finds capture.lease taken`,
  ReadLease: p => `window ${p} reads capture.lease`,
  JudgeHolder: (p, from, to) =>
    to.pc[p] === 'idle' ? `window ${p} sees the holder alive` : `window ${p} sees the holder dead`,
  CreateMarker: (p, from, to) =>
    to.pc[p] === 'electedReadLease' ? `window ${p} creates the reclaim marker` : `window ${p} finds a reclaim marker`,
  ElectedReadLease: p => `window ${p} reads capture.lease again`,
  ElectedUnlinkLease: (p, from) => `window ${p} deletes capture.lease, which names ${ownerName(from, from.lease)}`,
  UnlinkPassedMarker: p => `window ${p} deletes a dead reclaimer's marker`,
  UnlinkOwnMarker: p => `window ${p} deletes its reclaim marker`,
  ReadMarker: p => `window ${p} reads the reclaim marker`,
  JudgeElector: (p, from, to) => {
    if (from.alive[from.minter[from.mrec[p]]]) return `window ${p} sees the reclaimer alive`;
    // A model where this step deletes the marker (the F1 mutant) reads as what it does.
    return to.markers.length < from.markers.length
      ? `window ${p} sees the reclaimer dead and deletes the reclaim marker`
      : `window ${p} sees the reclaimer dead and moves to the next marker`;
  },
  WaitSeesChange: p => `window ${p} sees capture.lease change`,
  WaitTimesOut: p => `window ${p} gives up waiting`,
  FenceSeesLoss: p => `window ${p} finds its lease gone at a flush`,
  Finish: p => `window ${p} ends its capture`,
  ReleaseRead: p => `window ${p} reads capture.lease to give it back`,
  ReleaseUnlink: p => `window ${p} deletes its capture.lease`,
  Crash: p => `window ${p} dies`
};

export function step(action, from, to) {
  if (action === 'UserDeletesLease') return STEP.UserDeletesLease();
  const p = procsOf(from).find(
    q =>
      from.pc[q] !== to.pc[q] ||
      from.alive[q] !== to.alive[q] ||
      from.tok[q] !== to.tok[q] ||
      from.done[q] !== to.done[q]
  );
  const label = STEP[action];
  return label && p !== undefined ? label(p, from, to) : action;
}
