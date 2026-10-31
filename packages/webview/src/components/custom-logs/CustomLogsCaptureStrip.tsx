import React, { useId } from 'react';
import { Circle, Loader2, Pause, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { CustomLogCaptureChoice, CustomLogCaptureView } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { gapLinesOf, stripViewOf, type StripAction, type StripTone } from '../../utils/customLogs/captureStrip';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

type CustomLogsCaptureStripProps = {
  t: CustomLogsMessages;
  locale: string;
  sourceLabel: string;
  capture: CustomLogCaptureView;
  onStop: () => void;
  onStart: (initial?: CustomLogCaptureChoice) => void;
};

const TONE_ICON: Record<StripTone, LucideIcon> = {
  busy: Loader2,
  live: Circle,
  idle: Pause,
  attention: TriangleAlert
};

const TONE_COLOR: Record<StripTone, string> = {
  busy: 'animate-spin text-muted-foreground',
  live: 'fill-current text-[color:var(--vscode-charts-green,#388a34)]',
  idle: 'text-muted-foreground',
  attention: 'text-amber-400'
};

/**
 * The capture state of an event source, above the table: one status sentence, what the user can do about it,
 * and one line per gap the stored history may have. Status and gaps are separate elements, so a screen reader
 * announces a change of state without reading the gaps again.
 */
export function CustomLogsCaptureStrip({
  t,
  locale,
  sourceLabel,
  capture,
  onStop,
  onStart
}: CustomLogsCaptureStripProps) {
  const detailId = useId();
  const hintId = useId();
  const context = { t, locale, sourceLabel };
  const view = stripViewOf(capture, context);
  const gaps = gapLinesOf(capture.store, context);
  const Icon = TONE_ICON[view.tone];

  const renderAction = (kind: StripAction) => {
    switch (kind) {
      case 'stop':
        return (
          <Button key={kind} type="button" size="sm" variant="secondary" onClick={onStop}>
            {t.capture.stop}
          </Button>
        );
      case 'start':
        return (
          <Button key={kind} type="button" size="sm" variant="secondary" onClick={() => onStart()}>
            {t.capture.start}
          </Button>
        );
      case 'loadRetained':
        return (
          <Button key={kind} type="button" size="sm" aria-describedby={detailId} onClick={() => onStart('retained')}>
            {t.capture.firstUse.loadRetained}
          </Button>
        );
      case 'onlyNew':
        return (
          <Button key={kind} type="button" size="sm" variant="outline" onClick={() => onStart('new')}>
            {t.capture.firstUse.onlyNew}
          </Button>
        );
    }
  };

  return (
    <section
      aria-label={t.capture.aria}
      data-testid="custom-logs-capture"
      data-state={capture.capture.state}
      className="flex shrink-0 flex-col gap-1 border-b border-border px-3 py-1 text-xs"
    >
      <div className="flex min-h-[26px] flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className={cn('h-3 w-3 shrink-0', TONE_COLOR[view.tone])} aria-hidden="true" />
        <p role="status" className="min-w-0 flex-1">
          {view.label ? (
            <>
              {view.hint ? (
                <span tabIndex={0} title={view.hint} aria-describedby={hintId} className="cursor-help font-medium">
                  {view.label}
                </span>
              ) : (
                <span className="font-medium">{view.label}</span>
              )}
              {' · '}
            </>
          ) : null}
          {view.text}
        </p>
        {view.actions.map(renderAction)}
      </div>
      {view.hint ? (
        <span id={hintId} hidden>
          {view.hint}
        </span>
      ) : null}
      {view.detail ? (
        <p id={detailId} className="pl-5 text-muted-foreground">
          {view.detail}
        </p>
      ) : null}
      {gaps.length > 0 ? (
        <ul
          aria-label={t.capture.gaps.aria}
          aria-live="polite"
          aria-relevant="additions"
          className="flex flex-col gap-0.5 text-amber-400"
        >
          {gaps.map((line, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
