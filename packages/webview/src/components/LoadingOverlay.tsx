import React, { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

// After a first open, no frame holds the focus unless this call takes it, and keys can then stop reaching VS Code.
// The first overlay of a document comes with that load, so it keeps the call.
let isFirstOverlay = true;

export function LoadingOverlay({ show, label }: { show: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) {
      return;
    }
    // After the load, focus() would pull the focus out of the palette, an editor or a terminal, even from a hidden panel.
    if (isFirstOverlay || document.hasFocus()) {
      ref.current?.focus();
    }
    isFirstOverlay = false;
  }, [show]);

  if (!show) {
    return null;
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-label={label}
      className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm"
    >
      <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  );
}
