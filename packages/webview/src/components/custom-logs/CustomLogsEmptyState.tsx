import React from 'react';
import { Settings, TriangleAlert } from 'lucide-react';
import type { CustomLogConfigIssueView, CustomLogSourceView } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate } from '../../utils/customLogs/format';
import { Button } from '../ui/button';

type CustomLogsEmptyStateProps = {
  t: CustomLogsMessages;
  sources: readonly CustomLogSourceView[];
  issues: readonly CustomLogConfigIssueView[];
  onConfigure: () => void;
};

function describeSource(t: CustomLogsMessages, source: CustomLogSourceView): string | undefined {
  switch (source.state) {
    case 'ready':
      return undefined;
    case 'notInstalled':
      return fillTemplate(source.hint === 'collision' ? t.empty.collision : t.empty.notInstalled, { label: source.label });
    case 'unavailable':
      return fillTemplate(t.empty.unavailable, { label: source.label, message: source.message });
  }
}

/** Shown when no source can list rows: what each source reports, the mapping issues, and a way to fix the mapping. */
export function CustomLogsEmptyState({ t, sources, issues, onConfigure }: CustomLogsEmptyStateProps) {
  const reasons = sources.map(source => ({ id: source.id, text: describeSource(t, source) })).filter(reason => reason.text);
  return (
    <div data-testid="custom-logs-empty" className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4 text-sm">
      <div className="flex flex-col gap-1">
        <p className="font-medium">{t.empty.noSource}</p>
        <p className="text-muted-foreground">{t.empty.noSourceHint}</p>
      </div>
      {reasons.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {reasons.map(reason => (
            <li key={reason.id}>{reason.text}</li>
          ))}
        </ul>
      ) : null}
      {issues.length > 0 ? (
        <section aria-label={t.empty.issues} className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{t.empty.issues}</h3>
          <ul className="flex flex-col gap-1 text-xs">
            {issues.map((issue, index) => (
              <li
                key={`${issue.pointer}-${index}`}
                className={issue.severity === 'error' ? 'flex items-start gap-1.5 text-destructive' : 'flex items-start gap-1.5 text-amber-400'}
              >
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  <b>{issue.severity === 'error' ? t.empty.issueError : t.empty.issueWarning}</b> <code className="font-mono">{issue.pointer}</code>: {issue.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div>
        <Button type="button" variant="secondary" className="flex items-center gap-2" onClick={onConfigure}>
          <Settings className="h-4 w-4" aria-hidden="true" />
          <span>{t.configure}</span>
        </Button>
      </div>
    </div>
  );
}
