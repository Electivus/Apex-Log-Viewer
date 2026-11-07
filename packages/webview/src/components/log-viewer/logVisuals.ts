import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Bug,
  Cpu,
  Database,
  Edit3,
  Info,
  Settings,
  type LucideIcon
} from 'lucide-react';
import type { LogDiagnostic } from '@alv/protocol/logTriage';
import type { LogCategory } from '../../utils/logViewerParser';

export interface Visual {
  /** A category sets `--cat` from a VS Code chart color, a severity sets `--sev`. Tint, border and icon read it, never the text. */
  className: string;
  icon: LucideIcon;
}

export const CATEGORY_VISUALS: Record<LogCategory, Visual> = {
  debug: { className: 'log-cat-debug', icon: Bug },
  soql: { className: 'log-cat-soql', icon: Database },
  dml: { className: 'log-cat-dml', icon: Edit3 },
  code: { className: 'log-cat-code', icon: Settings },
  limit: { className: 'log-cat-limit', icon: AlertTriangle },
  error: { className: 'log-cat-error', icon: AlertOctagon },
  system: { className: 'log-cat-neutral', icon: Cpu },
  other: { className: 'log-cat-neutral', icon: Info }
};

export const SEVERITY_VISUALS: Record<LogDiagnostic['severity'], Visual> = {
  error: { className: 'log-sev-error', icon: AlertCircle },
  warning: { className: 'log-sev-warning', icon: AlertTriangle }
};
