import { createRequire } from 'node:module';
import { extractLogEventType, lineHasErrorSignal } from '../shared/logErrorSignals';
import {
  createUnreadableLogTriageSummary,
  normalizeLogTriageSummary,
  type LogDiagnostic,
  type LogTriageSummary
} from '../shared/logTriage';
import { getErrorMessage } from '../utils/error';
import { logWarn } from '../utils/logger';

type ParserTriageHelper = {
  summarizeLog(logText: string): unknown;
};

const TRIAGE_HELPER_MODULE_ID = 'tree-sitter-sfapex/bindings/node/sflog-triage';

let parserTriageHelper: ParserTriageHelper | null | undefined;
let parserTriageLoadFailed = false;

function loadParserTriageHelper(): ParserTriageHelper | null {
  if (parserTriageHelper !== undefined) {
    return parserTriageHelper;
  }

  try {
    const runtimeRequire = createRequire(__filename);
    const moduleExports = runtimeRequire(TRIAGE_HELPER_MODULE_ID) as Partial<ParserTriageHelper> | undefined;
    if (moduleExports && typeof moduleExports.summarizeLog === 'function') {
      parserTriageHelper = moduleExports as ParserTriageHelper;
      return parserTriageHelper;
    }
    throw new Error(`Module ${TRIAGE_HELPER_MODULE_ID} did not export summarizeLog()`);
  } catch (e) {
    parserTriageHelper = null;
    if (!parserTriageLoadFailed) {
      parserTriageLoadFailed = true;
      logWarn('LogTriage: parser helper unavailable, using line heuristics ->', getErrorMessage(e));
    }
    return null;
  }
}

export function summarizeLogTextWithHeuristics(logText: string): LogTriageSummary {
  const lines = String(logText ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line || !lineHasErrorSignal(line)) {
      continue;
    }

    const eventType = extractLogEventType(line);
    const primaryReason = eventType ? `Potential error event (${eventType})` : 'Potential error event';
    const reason: LogDiagnostic = {
      code: 'suspicious_error_payload',
      severity: 'warning',
      summary: primaryReason,
      line: index + 1
    };
    if (eventType) {
      reason.eventType = eventType;
    }

    return {
      hasErrors: true,
      primaryReason,
      reasons: [reason]
    };
  }

  return {
    hasErrors: false,
    reasons: []
  };
}

export function createUnreadableLogSummary(message?: string): LogTriageSummary {
  return createUnreadableLogTriageSummary(message);
}

export async function summarizeLogText(logText: string): Promise<LogTriageSummary> {
  const parserTriage = loadParserTriageHelper();
  if (!parserTriage) {
    return summarizeLogTextWithHeuristics(logText);
  }

  try {
    return normalizeLogTriageSummary(parserTriage.summarizeLog(logText));
  } catch (e) {
    logWarn('LogTriage: parser helper summarizeLog failed, using heuristics ->', getErrorMessage(e));
    return summarizeLogTextWithHeuristics(logText);
  }
}
