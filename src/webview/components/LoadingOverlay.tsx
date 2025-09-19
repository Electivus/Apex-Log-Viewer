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
      aria-label={label}
      className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center gap-2 bg-background/80 backdrop-blur-sm text-foreground cursor-progress"
    >
      <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
      {label && <span className="text-sm font-medium">{label}</span>}
    </div>
  );
}
