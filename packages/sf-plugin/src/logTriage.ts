import type { RuntimeLogDiagnostic, RuntimeLogTriageSummary } from './contracts.js';

// Diagnostic behavior derives from tree-sitter-sfapex's MIT-licensed
// sflog/triage.js. See THIRD_PARTY_NOTICES.md in the distributed package.

type DiagnosticContext = {
  eventDetail: string;
  eventType?: string;
  line: string;
  variableValue?: string;
};

type DiagnosticRule = {
  code: string;
  priority: number;
  severity: 'error' | 'warning';
  summary: string;
  test(context: DiagnosticContext): boolean;
};

const DML_STATUS_CODE_PATTERN =
  /REQUIRED_FIELD_MISSING|FIELD_INTEGRITY_EXCEPTION|DUPLICATE_VALUE|INVALID_FIELD_FOR_INSERT_UPDATE|STRING_TOO_LONG|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST|INVALID_CROSS_REFERENCE_KEY|CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY|DELETE_FAILED|ENTITY_IS_DELETED/;
const VALIDATION_STATUS_CODE_PATTERN = /FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION/;
const BENIGN_SERIALIZED_STATUS_CODE_PATTERN = /^(?:SUCCESS|OK|DONE|NO_ERROR|NONE)$/;
const VARIABLE_ASSIGNMENT_EVENT = 'VARIABLE_ASSIGNMENT';
const FATAL_ERROR_EVENT = 'FATAL_ERROR';
const EXCEPTION_THROWN_EVENT = 'EXCEPTION_THROWN';

function normalizeVariableValue(text: string | undefined): string {
  const normalized = String(text ?? '').trim();
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function extractSerializedStatusCode(text: string): string | undefined {
  return text.match(/\b(?:get)?statusCode=([A-Z][A-Z0-9_]+)\b/i)?.[1]?.toUpperCase();
}

function extractSerializedMessage(text: string): string | undefined {
  return text.match(/\bmessage=([\s\S]*?)(?:,\s*[A-Za-z_]+=|\])(?:\s*$)?/i)?.[1]?.trim();
}

function looksLikeSerializedErrorStatusCode(statusCode: string | undefined): boolean {
  return Boolean(statusCode && !BENIGN_SERIALIZED_STATUS_CODE_PATTERN.test(statusCode));
}

function looksLikeSerializedErrorMessage(message: string | undefined): boolean {
  const normalized = String(message ?? '').trim();
  if (!normalized) {
    return false;
  }
  if (/\b(?:no|without)\s+(?:error|errors|exception|exceptions|failure|failures)\b/i.test(normalized)) {
    return false;
  }
  return /\b(?:exception|failed|error)\b/i.test(normalized);
}

function looksLikeSerializedErrorPayload(text: string | undefined): boolean {
  const normalized = normalizeVariableValue(text);
  return (
    /^Error\s*\[/i.test(normalized) ||
    looksLikeSerializedErrorStatusCode(extractSerializedStatusCode(normalized)) ||
    looksLikeSerializedErrorMessage(extractSerializedMessage(normalized))
  );
}

function looksLikeExceptionPayload(text: string | undefined): boolean {
  const normalized = normalizeVariableValue(text);
  return /^[A-Za-z0-9_$.]+Exception:\s+\S/.test(normalized) || /^[A-Za-z0-9_$.]+Exception$/.test(normalized);
}

function looksLikeErrorBearingVariableValue(text: string | undefined): boolean {
  return looksLikeSerializedErrorPayload(text) || looksLikeExceptionPayload(text);
}

function looksLikeSerializedDmlErrorPayload(text: string | undefined): boolean {
  const normalized = normalizeVariableValue(text);
  const statusCode = extractSerializedStatusCode(normalized);
  return Boolean(
    /\bDatabase\.(?:Error|SaveResult)\b/.test(normalized) &&
    looksLikeSerializedErrorStatusCode(statusCode) &&
    !VALIDATION_STATUS_CODE_PATTERN.test(statusCode ?? '')
  );
}

function looksLikePlainValidationMessage(text: string | undefined): boolean {
  const normalized = normalizeVariableValue(text);
  return (
    /^(?:FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION)$/.test(normalized) ||
    /\b(?:FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION)\b(?=[,:])/.test(normalized)
  );
}

function looksLikePlainDmlMessage(text: string | undefined): boolean {
  return /\b(?:Insert|Update|Upsert|Delete|Merge) failed\. First exception on row\b/i.test(
    normalizeVariableValue(text)
  );
}

function looksLikePlainDmlStatusMessage(text: string | undefined): boolean {
  return new RegExp(`^(?:${DML_STATUS_CODE_PATTERN.source})(?=[,:]|$)`).test(normalizeVariableValue(text));
}

function looksLikePlainAssertionMessage(text: string | undefined): boolean {
  return /^Assertion Failed(?=[:.]|$)/i.test(normalizeVariableValue(text));
}

function looksLikeStructuredAssertionFailure(text: string | undefined): boolean {
  const normalized = normalizeVariableValue(text);
  return (
    /^(?:[A-Za-z0-9_$.]+\.)?AssertException(?::|\b)/.test(normalized) || looksLikePlainAssertionMessage(normalized)
  );
}

function looksLikeStructuredThrownValidationFailure(text: string): boolean {
  return (
    (/DmlException/.test(text) && VALIDATION_STATUS_CODE_PATTERN.test(text)) ||
    new RegExp(`(?:statusCode=|first error:\\s*)(?:${VALIDATION_STATUS_CODE_PATTERN.source})`).test(text)
  );
}

function looksLikeStructuredThrownDmlFailure(text: string): boolean {
  return (
    /DmlException/.test(text) ||
    new RegExp(`(?:statusCode=|first error:\\s*)(?:${DML_STATUS_CODE_PATTERN.source})`).test(text)
  );
}

function isVariableAssignmentEvent(eventType: string | undefined): boolean {
  return eventType === VARIABLE_ASSIGNMENT_EVENT;
}

function isThrownExceptionEvent(eventType: string | undefined): boolean {
  return eventType === EXCEPTION_THROWN_EVENT || eventType === FATAL_ERROR_EVENT;
}

function supportsFailureDiagnostic(eventType: string | undefined): boolean {
  return isVariableAssignmentEvent(eventType) || isThrownExceptionEvent(eventType);
}

function diagnosticCandidate(context: DiagnosticContext): string {
  return isVariableAssignmentEvent(context.eventType) ? (context.variableValue ?? '') : context.eventDetail;
}

const DIAGNOSTICS: DiagnosticRule[] = [
  {
    code: 'assertion_failure',
    summary: 'Assertion failure',
    severity: 'error',
    priority: 0,
    test(context) {
      return (
        supportsFailureDiagnostic(context.eventType) &&
        looksLikeStructuredAssertionFailure(diagnosticCandidate(context))
      );
    }
  },
  {
    code: 'validation_failure',
    summary: 'Validation failure',
    severity: 'error',
    priority: 1,
    test(context) {
      if (!supportsFailureDiagnostic(context.eventType)) {
        return false;
      }
      const candidate = diagnosticCandidate(context);
      if (
        isVariableAssignmentEvent(context.eventType) &&
        !looksLikeErrorBearingVariableValue(candidate) &&
        !looksLikePlainValidationMessage(candidate)
      ) {
        return false;
      }
      if (isThrownExceptionEvent(context.eventType) && !looksLikeStructuredThrownValidationFailure(candidate)) {
        return false;
      }
      return /FIELD_CUSTOM_VALIDATION_EXCEPTION|VALIDATION_EXCEPTION/i.test(candidate);
    }
  },
  {
    code: 'dml_failure',
    summary: 'DML failure',
    severity: 'error',
    priority: 2,
    test(context) {
      if (!supportsFailureDiagnostic(context.eventType)) {
        return false;
      }
      const candidate = diagnosticCandidate(context);
      if (
        isVariableAssignmentEvent(context.eventType) &&
        !looksLikeErrorBearingVariableValue(candidate) &&
        !looksLikePlainDmlMessage(candidate) &&
        !looksLikePlainDmlStatusMessage(candidate)
      ) {
        return false;
      }
      if (isThrownExceptionEvent(context.eventType) && !looksLikeStructuredThrownDmlFailure(candidate)) {
        return false;
      }
      return (
        /DmlException|Insert failed|Update failed|Upsert failed|Delete failed|Merge failed/i.test(candidate) ||
        DML_STATUS_CODE_PATTERN.test(candidate) ||
        looksLikeSerializedDmlErrorPayload(candidate)
      );
    }
  },
  {
    code: 'fatal_exception',
    summary: 'Fatal exception',
    severity: 'error',
    priority: 3,
    test(context) {
      if (context.eventType === FATAL_ERROR_EVENT) {
        return true;
      }
      if (isVariableAssignmentEvent(context.eventType)) {
        return looksLikeExceptionPayload(context.variableValue);
      }
      return context.eventType === EXCEPTION_THROWN_EVENT;
    }
  },
  {
    code: 'suspicious_error_payload',
    summary: 'Suspicious error payload',
    severity: 'warning',
    priority: 4,
    test(context) {
      return isVariableAssignmentEvent(context.eventType) && looksLikeSerializedErrorPayload(context.variableValue);
    }
  },
  {
    code: 'rollback_detected',
    summary: 'Rollback detected',
    severity: 'warning',
    priority: 5,
    test(context) {
      return context.eventType === 'ROLLBACK';
    }
  }
];

function extractEventType(line: string): string | undefined {
  const firstDelimiter = line.indexOf('|');
  if (firstDelimiter < 0) {
    return undefined;
  }
  const eventStart = firstDelimiter + 1;
  const nextDelimiter = line.indexOf('|', eventStart);
  const eventType = line.slice(eventStart, nextDelimiter < 0 ? undefined : nextDelimiter).trim();
  return eventType || undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractEventDetailValue(line: string, eventType: string | undefined): string {
  const eventPattern = eventType ? escapeRegExp(eventType) : '[^|]+';
  const match = line.match(
    new RegExp(`^[^|]*\\|\\s*${eventPattern}\\s*(?:\\|\\s*(\\[[^\\]]+\\]))?(?:\\|([\\s\\S]*))?$`)
  );
  return match?.[2] ?? '';
}

function extractVariableAssignmentValue(line: string): string {
  const match = line.match(
    /^[^|]*\|\s*VARIABLE_ASSIGNMENT\s*\|(?:\s*\[[^\]]+\]\s*\|)?[^|]*\|([\s\S]*?)(?:\|0x[0-9a-fA-F]+)?$/
  );
  return match?.[1] ?? line;
}

function buildDiagnosticContext(line: string): DiagnosticContext {
  const eventType = extractEventType(line);
  const context: DiagnosticContext = {
    line,
    eventType,
    eventDetail: extractEventDetailValue(line, eventType)
  };
  if (isVariableAssignmentEvent(eventType)) {
    context.variableValue = extractVariableAssignmentValue(line);
  }
  return context;
}

function isLogEntryStart(line: string): boolean {
  return /^\d{2}:\d{2}:\d{2}\.\d+(?:\s+\([^)]+\))?\s*\|[^|]+(?:\||$)/.test(line);
}

function splitLogEntries(logText: string): string[] {
  const entries: string[] = [];
  let currentEntry: string | undefined;

  for (const rawLine of String(logText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (isLogEntryStart(line)) {
      if (currentEntry) {
        entries.push(currentEntry);
      }
      currentEntry = line;
    } else if (currentEntry) {
      currentEntry += `\n${line}`;
    }
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }
  return entries;
}

function extractSourceLine(line: string): number | undefined {
  const sourceLine = line.match(/\|(\[(\d+)\]|\[[A-Z_]+\])\|/)?.[2];
  return sourceLine ? Number(sourceLine) : undefined;
}

function buildReason(rule: DiagnosticRule, rawLine: string, eventType: string | undefined): RuntimeLogDiagnostic {
  const reason: RuntimeLogDiagnostic = {
    code: rule.code,
    severity: rule.severity,
    summary: rule.summary
  };
  const line = extractSourceLine(rawLine);
  if (line !== undefined) {
    reason.line = line;
  }
  if (eventType) {
    reason.eventType = eventType;
  }
  return reason;
}

function matchingDiagnostics(context: DiagnosticContext): DiagnosticRule[] {
  const matches = DIAGNOSTICS.filter(diagnostic => diagnostic.test(context));
  const matchedCodes = new Set(matches.map(diagnostic => diagnostic.code));
  const hasSpecificError =
    matchedCodes.has('assertion_failure') || matchedCodes.has('validation_failure') || matchedCodes.has('dml_failure');

  return matches.filter(diagnostic => {
    if (diagnostic.code === 'fatal_exception' && hasSpecificError) {
      return false;
    }
    if (diagnostic.code === 'suspicious_error_payload' && matches.some(candidate => candidate.severity === 'error')) {
      return false;
    }
    return true;
  });
}

/**
 * Summarizes the small set of structured Apex log events used by both the CLI
 * and extension. This intentionally avoids a full syntax tree: triage needs
 * only logical log-entry boundaries, event types, source locations and payloads.
 */
export function summarizeLogText(logText: string): RuntimeLogTriageSummary {
  const reasonsByCode = new Map<string, RuntimeLogDiagnostic>();

  for (const line of splitLogEntries(logText)) {
    const context = buildDiagnosticContext(line);
    for (const diagnostic of matchingDiagnostics(context)) {
      if (!reasonsByCode.has(diagnostic.code)) {
        reasonsByCode.set(diagnostic.code, buildReason(diagnostic, line, context.eventType));
      }
    }
  }

  const priorityByCode = new Map(DIAGNOSTICS.map(diagnostic => [diagnostic.code, diagnostic.priority]));
  const reasons = [...reasonsByCode.values()].sort(
    (left, right) =>
      (priorityByCode.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
      (priorityByCode.get(right.code) ?? Number.MAX_SAFE_INTEGER)
  );

  return {
    hasErrors: reasons.length > 0,
    primaryReason: reasons[0]?.summary,
    reasons
  };
}
