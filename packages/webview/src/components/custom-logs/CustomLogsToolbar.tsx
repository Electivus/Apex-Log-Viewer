import React from 'react';
import { ExternalLink, Loader2, RefreshCw, Settings } from 'lucide-react';
import type { OrgItem } from '@alv/protocol/types';
import type { CustomLogsMessages } from '../../i18n';
import { Button } from '../ui/button';
import { LabeledSelect } from '../LabeledSelect';
import { OrgSelect } from '../OrgSelect';

/** The label sits beside the select, so the toolbar stays one row tall in a short panel. */
const INLINE_SELECT = 'min-w-0 flex-row items-center gap-2';

type CustomLogsToolbarProps = {
  t: CustomLogsMessages;
  orgLabel: string;
  noOrgsText: string;
  orgs: OrgItem[];
  selectedOrg?: string;
  onSelectOrg: (username: string) => void;
  /** Ready sources. The picker only shows when there is a choice to make. */
  sources: Array<{ id: string; label: string }>;
  selectedSource?: string;
  onSelectSource: (sourceId: string) => void;
  loading: boolean;
  showOpenInEditor: boolean;
  onRefresh: () => void;
  onOpenInEditor: () => void;
  onConfigure: () => void;
};

export function CustomLogsToolbar({
  t,
  orgLabel,
  noOrgsText,
  orgs,
  selectedOrg,
  onSelectOrg,
  sources,
  selectedSource,
  onSelectSource,
  loading,
  showOpenInEditor,
  onRefresh,
  onOpenInEditor,
  onConfigure
}: CustomLogsToolbarProps) {
  return (
    <section className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-1">
      <OrgSelect
        label={orgLabel}
        orgs={orgs}
        selected={selectedOrg}
        onChange={onSelectOrg}
        testId="custom-logs-org"
        emptyText={noOrgsText}
        className={INLINE_SELECT}
      />
      {sources.length > 1 ? (
        <LabeledSelect
          label={t.source}
          value={selectedSource ?? ''}
          onChange={onSelectSource}
          options={sources.map(source => ({ value: source.id, label: source.label }))}
          testId="custom-logs-source"
          className={INLINE_SELECT}
          triggerClassName="min-w-[200px]"
        />
      ) : null}
      <span className="flex-1" />
      <Button
        type="button"
        variant="secondary"
        className="flex items-center gap-2"
        disabled={loading}
        onClick={onRefresh}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        )}
        <span>{t.refresh}</span>
      </Button>
      {showOpenInEditor ? (
        <Button
          type="button"
          variant="outline"
          className="flex items-center gap-2"
          title={t.openInEditorTitle}
          onClick={onOpenInEditor}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          <span>{t.openInEditor}</span>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={t.configureTitle}
        aria-label={t.configure}
        onClick={onConfigure}
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
      </Button>
    </section>
  );
}
