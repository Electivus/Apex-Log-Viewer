import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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
const HEURISTIC_SCAN_CHUNK_BYTES = 64 * 1024;

function disableParserTriageHelper(message: string, error: unknown): void {
  parserTriageHelper = null;
  if (!parserTriageLoadFailed) {
    parserTriageLoadFailed = true;
    logWarn(message, getErrorMessage(error));
  }
}

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
    disableParserTriageHelper('LogTriage: parser helper unavailable, using line heuristics ->', e);
    return null;
  }
}

function createPotentialErrorSummary(line: string | undefined, lineNumber: number): LogTriageSummary | null {
  const trimmedLine = String(line ?? '').trim();
  if (!trimmedLine || !lineHasErrorSignal(trimmedLine)) {
    return null;
  }

  const eventType = extractLogEventType(trimmedLine);
  const primaryReason = eventType ? `Potential error event (${eventType})` : 'Potential error event';
  const reason: LogDiagnostic = {
    code: 'suspicious_error_payload',
    severity: 'warning',
    summary: primaryReason,
    line: lineNumber
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

function createNoErrorsSummary(): LogTriageSummary {
  return {
    hasErrors: false,
    reasons: []
  };
}

export function summarizeLogTextWithHeuristics(logText: string): LogTriageSummary {
  const lines = String(logText ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const summary = createPotentialErrorSummary(lines[index], index + 1);
    if (summary) {
      return summary;
    }
  }

  return createNoErrorsSummary();
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
    disableParserTriageHelper('LogTriage: parser helper summarizeLog failed, disabling parser helper ->', e);
    return summarizeLogTextWithHeuristics(logText);
  }
}

export async function summarizeLogFileWithHeuristics(filePath: string): Promise<LogTriageSummary> {
  const handle = await fs.open(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(HEURISTIC_SCAN_CHUNK_BYTES);
  let lineNumber = 0;
  let remainder = '';

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }

      const chunkText = remainder + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunkText.split(/\r?\n/);
      remainder = lines.pop() ?? '';

      for (const line of lines) {
        lineNumber += 1;
        const summary = createPotentialErrorSummary(line, lineNumber);
        if (summary) {
          return summary;
        }
      }
    }

    const finalLine = remainder + decoder.end();
    if (finalLine.length > 0) {
      lineNumber += 1;
      const summary = createPotentialErrorSummary(finalLine, lineNumber);
      if (summary) {
        return summary;
      }
    }

    return createNoErrorsSummary();
  } finally {
    await handle.close();
  }
}

export async function summarizeLogFile(filePath: string): Promise<LogTriageSummary> {
  const parserTriage = loadParserTriageHelper();
  if (!parserTriage) {
    return summarizeLogFileWithHeuristics(filePath);
  }

  let logText = '';
  try {
    logText = await fs.readFile(filePath, 'utf8');
    return normalizeLogTriageSummary(parserTriage.summarizeLog(logText));
  } catch (e) {
    disableParserTriageHelper('LogTriage: parser helper summarizeLog failed for file, disabling parser helper ->', e);
    return logText ? summarizeLogTextWithHeuristics(logText) : summarizeLogFileWithHeuristics(filePath);
  }
}
