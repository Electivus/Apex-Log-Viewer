// Typed telemetry event catalog for this extension.
// Keep properties low-cardinality and PII-free.

export type BoolStr = 'true' | 'false';
export type Outcome = 'ok' | 'error' | 'cancel' | 'aborted';
export type View = 'logs' | 'tail';

export interface TelemetryEventMap {
  'extension.install': { version: string };
  'extension.update': { from: string; to: string };
  'extension.activate': { hasWorkspace: BoolStr };

  'command.refresh': { outcome?: Extract<Outcome, 'ok' | 'error'> } | undefined;
  'command.selectOrg': {
    outcome: 'picked' | 'cancel' | 'error';
    orgs?: '0' | '1' | '2-5' | '6-10' | '10+';
    hasDefault?: BoolStr;
    code?: string; // error code only on failures
  };
  'command.tail': { outcome?: Extract<Outcome, 'ok' | 'error'> } | undefined;

  'logs.refresh': { outcome: Extract<Outcome, 'ok' | 'error'> };
  'logs.loadMore': { outcome: Extract<Outcome, 'ok' | 'error'> };
  'log.open': { view: View; outcome?: Extract<Outcome, 'ok' | 'error'> };
  'logs.replay': { view: View; outcome: Extract<Outcome, 'ok' | 'error'> };
  'orgs.list': { view: View; outcome: Extract<Outcome, 'ok' | 'error'> };
  'debugLevels.load': { outcome: Extract<Outcome, 'ok' | 'error'> };

  'tail.start': { outcome?: Outcome; hasDebugLevel?: BoolStr } | undefined;
  'tail.stop': { reason?: 'user' | 'auto' | 'viewDispose' | 'orgChange' | 'error' } | undefined;

  // UI (webview) events
  'ui.logs.ready': {} | undefined;
  'ui.logs.firstData': { outcome?: Extract<Outcome, 'ok' | 'error'> } | undefined;
  'ui.tail.ready': {} | undefined;
  'ui.tail.firstData': { outcome?: Extract<Outcome, 'ok' | 'error'> } | undefined;
}
