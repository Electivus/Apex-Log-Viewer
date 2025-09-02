import React, { useMemo, useState } from 'react';

type Kind = 'Trigger' | 'Flow' | 'Class' | 'Other';

export function EntityFilter({
  entities,
  hidden,
  onChangeHidden,
  onClose
}: {
  entities: { id: string; label: string; kind: Kind }[];
  hidden: Set<string>;
  onChangeHidden: (next: Set<string>) => void;
  onClose?: () => void;
}) {
  const [q, setQ] = useState('');

  const grouped = useMemo(() => {
    const byKind: Record<Kind, { id: string; label: string; kind: Kind }[]> = {
      Trigger: [],
      Flow: [],
      Class: [],
      Other: []
    };
    const query = q.trim().toLowerCase();
    for (const e of entities) {
      if (query) {
        const hay = `${e.kind}:${e.label}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      byKind[e.kind].push(e);
    }
    return byKind;
  }, [entities, q]);

  const counts = useMemo(() => {
    const total = entities.length;
    const hiddenCount = hidden.size;
    return { total, hiddenCount, visibleCount: total - hiddenCount };
  }, [entities.length, hidden.size]);

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeHidden(next);
  };

  const setAll = (ids: string[], hiddenOn: boolean) => {
    const next = new Set(hidden);
    if (hiddenOn) {
      for (const id of ids) next.add(id);
    } else {
      for (const id of ids) next.delete(id);
    }
    onChangeHidden(next);
  };

  const kinds: Kind[] = ['Trigger', 'Flow', 'Class', 'Other'];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--vscode-editorGroup-border, rgba(148,163,184,0.25))' }}>
        <input
          autoFocus
          type="text"
          placeholder="Search entities..."
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--vscode-input-border, rgba(148,163,184,0.35))', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)' }}
        />
        <button type="button" onClick={() => setQ('')}>Clear</button>
        {onClose && (
          <button type="button" onClick={onClose}>Close</button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--vscode-editorGroup-border, rgba(148,163,184,0.25))', fontSize: 12 }}>
        <span>Total: {counts.total}</span>
        <span>Hidden: {counts.hiddenCount}</span>
        <span>Visible: {counts.visibleCount}</span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" onClick={() => onChangeHidden(new Set())}>Show all</button>
        <button type="button" onClick={() => onChangeHidden(new Set(entities.map(e => e.id)))}>Hide all</button>
      </div>
      <div style={{ padding: 10 }}>
        {kinds.map(kind => {
          const list = grouped[kind];
          if (!list || list.length === 0) return null;
          const ids = list.map(e => e.id);
          const allHidden = ids.every(id => hidden.has(id));
          return (
            <div key={kind} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontWeight: 700, opacity: 0.9 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: kind === 'Trigger' ? 'rgba(96,165,250,0.14)' : kind === 'Flow' ? 'rgba(167,139,250,0.14)' : kind === 'Class' ? 'rgba(52,211,153,0.14)' : 'rgba(148,163,184,0.10)', border: `1px solid ${kind === 'Trigger' ? '#60a5fa' : kind === 'Flow' ? '#a78bfa' : kind === 'Class' ? '#34d399' : 'rgba(148,163,184,0.9)'}` }} />
                <span>{kind}</span>
                <span style={{ marginLeft: 'auto' }} />
                <button type="button" onClick={() => setAll(ids, false)}>Show</button>
                <button type="button" onClick={() => setAll(ids, true)}>{allHidden ? 'Hidden' : 'Hide'}</button>
              </div>
              {list.map(e => (
                <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                  <input type="checkbox" checked={hidden.has(e.id)} onChange={() => toggle(e.id)} />
                  <span style={{ opacity: 0.85 }}>Hide</span>
                  <span style={{ opacity: 0.9 }}>{e.label}</span>
                  <span style={{ opacity: 0.6 }}>· {e.id.split(':')[0]}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default EntityFilter;
