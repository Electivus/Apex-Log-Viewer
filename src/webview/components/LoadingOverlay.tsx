import React, { useEffect, useRef } from 'react';

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2,
  color: 'var(--vscode-foreground)',
  // Subtle dim to indicate blocking state
  background: 'rgba(0, 0, 0, 0.15)',
  // Slight blur helps convey disabled background without heavy contrast
  backdropFilter: 'blur(1px)',
  // Show busy cursor
  cursor: 'progress',
  // Block interactions with underlying controls while loading
  pointerEvents: 'auto'
};

export function LoadingOverlay({ show, label }: { show: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (show) {
      ref.current?.focus();
    }
  }, [show]);
  if (!show) {
    return null;
  }
  return (
    <div ref={ref} tabIndex={-1} role="status" aria-label={label} style={overlayStyle}>
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" stroke="var(--vscode-progressBar-background)" strokeWidth="2" fill="none" />
        <path d="M12 3 A9 9 0 0 1 21 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="1s"
            repeatCount="indefinite"
          />
        </path>
      </svg>
    </div>
  );
}
