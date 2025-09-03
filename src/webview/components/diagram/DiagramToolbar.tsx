import React from 'react';

export function DiagramToolbar({
  hideSystem,
  onToggleHideSystem,
  collapseRepeats,
  onToggleCollapseRepeats,
  onExpandAll,
  onCollapseAll,
  showProfilingChips,
  onToggleShowProfilingChips,
  showProfilingSidebar,
  onToggleShowProfilingSidebar,
  entityPanelOpen,
  onToggleEntityPanel,
  hiddenCount
}: {
  hideSystem: boolean;
  onToggleHideSystem: (v: boolean) => void;
  collapseRepeats: boolean;
  onToggleCollapseRepeats: (v: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  showProfilingChips: boolean;
  onToggleShowProfilingChips: (v: boolean) => void;
  showProfilingSidebar: boolean;
  onToggleShowProfilingSidebar: (v: boolean) => void;
  entityPanelOpen: boolean;
  onToggleEntityPanel: (v: boolean) => void;
  hiddenCount: number;
}) {
  const Swatch = ({ stroke, fill, label }: { stroke: string; fill: string; label: string }) => (
    <span className="item">
      <span className="swatch" style={{ background: fill, border: `1px solid ${stroke}` }} />
      {label}
    </span>
  );

  return (
    <div className="toolbar">
      <button type="button" onClick={() => onToggleEntityPanel(!entityPanelOpen)}>
        Entities{hiddenCount ? ` (${hiddenCount} hidden)` : ''} {entityPanelOpen ? '▴' : '▾'}
      </button>
      <label>
        <input type="checkbox" checked={hideSystem} onChange={e => onToggleHideSystem(e.target.checked)} /> Hide System
      </label>
      <label>
        <input
          type="checkbox"
          checked={collapseRepeats}
          onChange={e => onToggleCollapseRepeats(e.target.checked)}
        />{' '}
        Collapse repeats
      </label>
      <button type="button" onClick={onExpandAll}>
        Expand all
      </button>
      <button type="button" onClick={onCollapseAll}>
        Collapse all
      </button>
      <label>
        <input
          type="checkbox"
          checked={showProfilingChips}
          onChange={e => onToggleShowProfilingChips(e.target.checked)}
        />{' '}
        Show profiling
      </label>
      <label>
        <input
          type="checkbox"
          checked={showProfilingSidebar}
          onChange={e => onToggleShowProfilingSidebar(e.target.checked)}
        />{' '}
        Sidebar
      </label>
      <div className="legend">
        <Swatch stroke="#60a5fa" fill="rgba(96,165,250,0.14)" label="Trigger" />
        <Swatch stroke="#a78bfa" fill="rgba(167,139,250,0.14)" label="Flow" />
        <Swatch stroke="#34d399" fill="rgba(52,211,153,0.14)" label="Class" />
        <Swatch stroke="rgba(148,163,184,0.9)" fill="rgba(148,163,184,0.10)" label="Other" />
        <span className="item" style={{ opacity: 0.9 }}>· S: SOQL</span>
        <span className="item" style={{ opacity: 0.9 }}>· D: DML</span>
        <span className="item" style={{ opacity: 0.9 }}>· C: Callout</span>
      </div>
    </div>
  );
}
