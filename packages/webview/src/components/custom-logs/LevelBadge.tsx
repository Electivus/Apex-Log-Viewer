import React from 'react';
import type { CustomLogLevel } from '@alv/protocol/customLogsTypes';
import { cn } from '../../lib/utils';

const LEVEL_COLOR: Record<CustomLogLevel, string> = {
  ERROR: 'var(--vscode-charts-red, #f14c4c)',
  WARN: 'var(--vscode-charts-yellow, #cca700)',
  INFO: 'var(--vscode-charts-blue, #3794ff)',
  DEBUG: 'var(--vscode-charts-purple, #b180d7)',
  FINE: 'var(--vscode-descriptionForeground, #8b949e)',
  FINER: 'var(--vscode-descriptionForeground, #8b949e)',
  FINEST: 'var(--vscode-descriptionForeground, #8b949e)'
};

export function LevelBadge({ level, rawLevel, className }: { level?: CustomLogLevel; rawLevel?: string; className?: string }) {
  const label = level ?? rawLevel;
  if (!label) {
    return <span className="text-muted-foreground">—</span>;
  }
  const color = level ? LEVEL_COLOR[level] : 'var(--vscode-descriptionForeground, #8b949e)';
  return (
    <span
      data-level={level ?? 'unmapped'}
      className={cn('inline-flex items-center rounded-full border px-2 text-[10px] font-semibold leading-[15px] tracking-wide', className)}
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 15%, transparent)`
      }}
    >
      {label}
    </span>
  );
}
