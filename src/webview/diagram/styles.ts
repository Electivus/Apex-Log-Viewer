export type ActorKind = 'Trigger' | 'Flow' | 'Class' | 'Other';

export function kindFromActor(actor: string): ActorKind {
  if (actor.startsWith('Trigger:')) return 'Trigger';
  if (actor.startsWith('Flow:')) return 'Flow';
  if (actor.startsWith('Class:')) return 'Class';
  return 'Other';
}

export function styleByKind(kind: ActorKind) {
  switch (kind) {
    case 'Trigger':
      return { stroke: '#60a5fa', fill: 'rgba(96,165,250,0.14)' };
    case 'Flow':
      return { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.14)' };
    case 'Class':
      return { stroke: '#34d399', fill: 'rgba(52,211,153,0.14)' };
    default:
      return { stroke: 'rgba(148,163,184,0.9)', fill: 'rgba(148,163,184,0.10)' };
  }
}
