import React from 'react';
import { Button } from '../ui/button';
import { logViewerEn, type LogViewerMessages } from '../../i18n/logViewer';
import { fillTemplate } from '../../utils/customLogs/format';
import type { LogFailure } from '../../utils/logViewerSummary';
import { CATEGORY_VISUALS } from './logVisuals';

interface Props {
  failure: LogFailure;
  onGoToError: () => void;
  t?: LogViewerMessages;
}

const { icon: FailureIcon } = CATEGORY_VISUALS.error;

export function LogFailureBanner({ failure, onGoToError, t = logViewerEn }: Props) {
  return (
    <section
      role="alert"
      aria-label={t.failure.label}
      data-testid="log-viewer-failure"
      className="log-failure-banner flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
    >
      <FailureIcon className="log-sev-error log-sev-icon h-4 w-4 shrink-0" aria-hidden="true" />
      <span title={failure.message} className="line-clamp-2 min-w-0 break-words font-medium">
        {failure.message}
      </span>
      {failure.lineNumber !== undefined && (
        <span className="shrink-0 text-xs">{fillTemplate(t.diagnostics.line, { line: failure.lineNumber })}</span>
      )}
      <span className="flex-1" />
      <Button
        type="button"
        size="sm"
        className="border border-[color:var(--vscode-button-border,transparent)]"
        data-testid="log-viewer-go-to-error"
        onClick={onGoToError}
      >
        {t.failure.goToError}
      </Button>
    </section>
  );
}
