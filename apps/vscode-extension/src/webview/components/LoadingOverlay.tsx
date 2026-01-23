import React, { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

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
