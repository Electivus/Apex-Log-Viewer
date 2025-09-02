import { useMemo } from 'react';
import type { DiagramNested, DiagramNestedWithCount, DiagramKind, DiagramStyle } from '../../shared/diagramTypes';

export function useDiagramData() {
  const unitId = (frame: DiagramNested): string => {
    return `${frame.actor}:${frame.start}`;
  };

  const kindFromActor = (actor: string): DiagramKind => {
    if (actor.startsWith('Trigger:')) return 'Trigger';
    if (actor.startsWith('Flow:')) return 'Flow';
    if (actor.startsWith('Class:')) return 'Class';
    return 'Other';
  };

  const styleByKind = (kind: DiagramKind): DiagramStyle => {
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
  };

  const truncate = (text: string, max = 38): string => {
    return text && text.length > max ? text.slice(0, max - 1) + '…' : text || '';
  };

  const sanitizeText = (text: string): string => {
    if (!text) return '';
    // Remove control chars except common whitespace; keep visible text intact.
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  };

  const filterAndCollapse = (
    frames: DiagramNested[] | undefined,
    hideSystem: boolean,
    collapseRepeats: boolean
  ): DiagramNestedWithCount[] => {
    let list: DiagramNested[] = (frames || []).slice();

    if (hideSystem) {
      list = list.filter(frame => !/^Class:System\b/.test(frame.actor) && !/^System\./.test(frame.label));
    }

    // Sort by start time and depth
    list.sort((a, b) => a.start - b.start || a.depth - b.depth);

    if (!collapseRepeats) return list as DiagramNestedWithCount[];

    // Collapse consecutive repeats on same lane, same depth and same label
    const result: DiagramNestedWithCount[] = [];
    for (const frame of list) {
      const prev = result[result.length - 1];
      if (
        prev &&
        prev.actor === frame.actor &&
        prev.depth === frame.depth &&
        prev.label === frame.label &&
        (prev.end ?? prev.start) <= frame.start
      ) {
        prev.end = frame.end ?? frame.start + 1;
        prev.count = (prev.count || 1) + 1;
      } else {
        result.push({ ...frame });
      }
    }
    return result;
  };

  return {
    utils: {
      unitId,
      kindFromActor,
      styleByKind,
      truncate,
      sanitizeText,
      filterAndCollapse
    }
  };
}
