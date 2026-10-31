/**
 * The Custom Logs list surface (bottom-panel view and its editor tab), hosted by a
 * Webview Session.
 *
 * Prefixed `customLogs*` so this parser accepts only this surface's messages (Logs and Tail
 * share one unprefixed parser, which lets a Tail message validate at the Logs provider).
 *
 * Replay: every outbound message is `replayable`. The provider's snapshot is exactly
 * Init, Orgs, Sources, Filter, PayloadColumns, Page (mode 'replace', all loaded rows, live rows
 * included, and the payload fields merged across them), Capture (only while the selected source
 * is an event source), Loading, Error, so a remount reproduces the screen from the latest of each.
 */

import type { OrgItem } from './types.js';
import { parseCustomLogLevel, parseSinceValue } from './customLogsRules.js';
import {
  CUSTOM_LOG_CAPTURE_CHOICES,
  parseCustomLogPayloadColumns,
  parseCustomLogRowId,
  type CustomLogCaptureChoice,
  type CustomLogCaptureView,
  type CustomLogColumn,
  type CustomLogConfigIssueView,
  type CustomLogPayloadColumnsView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogSourceView,
  type CustomLogsFilterView
} from './customLogsTypes.js';

export type CustomLogsFromWebviewMessage =
  /** Must echo the `alv-mount-sequence` meta value, or the session rejects it after a remount. */
  | { type: 'customLogsReady'; mountSequence?: number }
  | { type: 'customLogsSelectOrg'; target: string }
  /**
   * `filter`, when present, is the complete server-side filter typed together with the switch: the provider
   * applies it to the new source in the same query, so the old source is not reloaded with it first.
   */
  | { type: 'customLogsSelectSource'; sourceId: string; filter?: CustomLogsFilterView }
  /** The complete server-side filter. Core applies it to the query and the provider restarts paging. */
  | { type: 'customLogsSetFilter'; filter: CustomLogsFilterView }
  | { type: 'customLogsRefresh' }
  /** No cursor from the webview: the provider owns it. */
  | { type: 'customLogsLoadMore' }
  /** Accepted only for an id present in the provider's current rows. */
  | { type: 'customLogsOpenLog'; logId: string }
  /**
   * Opens the full payload of a listed row as a read-only text document. Accepted only for an id
   * present in the provider's current rows; the text stays in the host.
   */
  | { type: 'customLogsOpenPayload'; logId: string }
  /** The JSON columns this workspace adds for the selected source; the host stores them in workspace state. */
  | { type: 'customLogsSetPayloadColumns'; added: string[] }
  /** Opens `sfdx-project.json` at `plugins.electivus.customLogs` (same as the configure command). */
  | { type: 'customLogsOpenConfig' }
  /** Opens the same view in an editor tab. */
  | { type: 'customLogsOpenEditor' }
  /**
   * Stops or starts capture for the selected event source. `initial` answers the `needsInitial` prompt
   * and travels only with `start`; the host ignores it when the store already has a position.
   */
  | { type: 'customLogsCapture'; action: 'stop' }
  | { type: 'customLogsCapture'; action: 'start'; initial?: CustomLogCaptureChoice };

export type CustomLogsToWebviewMessage =
  /** `surface` 'editor' hides the "open in editor" action; absent means the bottom-panel view. */
  | { type: 'customLogsInit'; locale: string; surface?: 'view' | 'editor' }
  | { type: 'customLogsOrgs'; data: OrgItem[]; selected?: string }
  | { type: 'customLogsSources'; data: CustomLogSourceView[]; selected?: string; issues: CustomLogConfigIssueView[] }
  | { type: 'customLogsFilter'; value: CustomLogsFilterView }
  | { type: 'customLogsPayloadColumns'; value: CustomLogPayloadColumnsView }
  | { type: 'customLogsLoading'; value: boolean }
  /** The capture strip's state; `value` undefined clears it (the selected source is not an event source). */
  | { type: 'customLogsCapture'; value?: CustomLogCaptureView }
  /**
   * Rows a capture stored, already decoded and filtered for this view, merged into the loaded page by
   * `mergeLiveRows` with their `payloadFields`. The provider folds them into its snapshot, so a remount
   * replays them inside the one `customLogsPage` replace.
   */
  | { type: 'customLogsLiveRows'; rows: CustomLogRow[]; payloadFields: CustomLogPayloadField[] }
  | {
      type: 'customLogsPage';
      mode: 'replace' | 'append';
      columns: CustomLogColumn[];
      rows: CustomLogRow[];
      /** This page's paths on `append`; every loaded page's, merged, on `replace`. */
      payloadFields: CustomLogPayloadField[];
      hasMore: boolean;
    }
  /** `message` undefined clears the banner; the snapshot keeps the latest value either way. */
  | { type: 'customLogsError'; message?: string };

const MAX_ORG_IDENTIFIER_LENGTH = 320;
const MAX_USERNAME_LENGTH = 255;
const MAX_SINCE_LENGTH = 64;
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseTrimmedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** A present field must be valid and non-blank, an absent one is simply not set. Any invalid field rejects the filter. */
function parseCustomLogsFilter(value: unknown): CustomLogsFilterView | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }
  const filter: CustomLogsFilterView = {};
  if (raw.minLevel !== undefined) {
    const minLevel = parseCustomLogLevel(raw.minLevel);
    if (!minLevel) {
      return undefined;
    }
    filter.minLevel = minLevel;
  }
  if (raw.user !== undefined) {
    const user = parseTrimmedString(raw.user, MAX_USERNAME_LENGTH);
    if (!user) {
      return undefined;
    }
    filter.user = user;
  }
  if (raw.since !== undefined) {
    const since = parseSinceValue(parseTrimmedString(raw.since, MAX_SINCE_LENGTH));
    if (!since) {
      return undefined;
    }
    filter.since = since;
  }
  return filter;
}

/**
 * Hand-written validator in the style of `parseDebugFlagsFromWebviewMessage`: length caps,
 * record-id and source-id patterns, `minLevel` in CUSTOM_LOG_LEVELS, `since` must be a duration or
 * an ISO instant with an offset (what core accepts), at most 50 payload columns of at most 255 characters,
 * a capture `stop` with nothing else or a `start` with an optional `initial` of `retained` or `new`. Returns
 * undefined for anything else.
 */
export function parseCustomLogsFromWebviewMessage(raw: unknown): CustomLogsFromWebviewMessage | undefined {
  const message = asRecord(raw);
  if (!message) {
    return undefined;
  }

  switch (message.type) {
    case 'customLogsRefresh':
    case 'customLogsLoadMore':
    case 'customLogsOpenConfig':
    case 'customLogsOpenEditor':
      return { type: message.type };
    case 'customLogsReady': {
      const mountSequence = parseNonNegativeInteger(message.mountSequence);
      return mountSequence === undefined ? { type: 'customLogsReady' } : { type: 'customLogsReady', mountSequence };
    }
    case 'customLogsSelectOrg': {
      const target = parseTrimmedString(message.target, MAX_ORG_IDENTIFIER_LENGTH);
      return target ? { type: 'customLogsSelectOrg', target } : undefined;
    }
    case 'customLogsSelectSource': {
      if (typeof message.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(message.sourceId)) {
        return undefined;
      }
      if (message.filter === undefined) {
        return { type: 'customLogsSelectSource', sourceId: message.sourceId };
      }
      const filter = parseCustomLogsFilter(message.filter);
      return filter ? { type: 'customLogsSelectSource', sourceId: message.sourceId, filter } : undefined;
    }
    case 'customLogsSetFilter': {
      const filter = parseCustomLogsFilter(message.filter);
      return filter ? { type: 'customLogsSetFilter', filter } : undefined;
    }
    case 'customLogsOpenLog':
    case 'customLogsOpenPayload': {
      const logId = parseCustomLogRowId(message.logId);
      return logId ? { type: message.type, logId } : undefined;
    }
    case 'customLogsSetPayloadColumns': {
      const added = parseCustomLogPayloadColumns(message.added);
      return added ? { type: 'customLogsSetPayloadColumns', added } : undefined;
    }
    case 'customLogsCapture': {
      if (message.action === 'stop') {
        return message.initial === undefined ? { type: 'customLogsCapture', action: 'stop' } : undefined;
      }
      if (message.action !== 'start') {
        return undefined;
      }
      if (message.initial === undefined) {
        return { type: 'customLogsCapture', action: 'start' };
      }
      const initial = CUSTOM_LOG_CAPTURE_CHOICES.find(choice => choice === message.initial);
      return initial ? { type: 'customLogsCapture', action: 'start', initial } : undefined;
    }
    default:
      return undefined;
  }
}
