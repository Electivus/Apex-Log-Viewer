export type LogDiagnosticCode =
  | 'fatal_exception'
  | 'assertion_failure'
  | 'validation_failure'
  | 'dml_failure'
  | 'rollback_detected'
  | 'suspicious_error_payload';

export type LogDiagnosticSeverity = 'error' | 'warning';

export interface LogDiagnostic {
  code: LogDiagnosticCode;
  severity: LogDiagnosticSeverity;
  summary: string;
  line?: number;
  eventType?: string;
}

export interface LogTriageSummary {
  hasErrors: boolean;
  primaryReason?: string;
  reasons: LogDiagnostic[];
}

const LOG_DIAGNOSTIC_CODES = new Set<LogDiagnosticCode>([
  'fatal_exception',
  'assertion_failure',
  'validation_failure',
  'dml_failure',
  'rollback_detected',
  'suspicious_error_payload'
]);

const LOG_DIAGNOSTIC_SEVERITIES = new Set<LogDiagnosticSeverity>(['error', 'warning']);

export const EMPTY_LOG_TRIAGE_SUMMARY: LogTriageSummary = {
  hasErrors: false,
  reasons: []
};

export function isLogDiagnosticCode(value: string): value is LogDiagnosticCode {
  return LOG_DIAGNOSTIC_CODES.has(value as LogDiagnosticCode);
}

export function isLogDiagnosticSeverity(value: string): value is LogDiagnosticSeverity {
  return LOG_DIAGNOSTIC_SEVERITIES.has(value as LogDiagnosticSeverity);
}

export function normalizeLogDiagnostic(value: unknown): LogDiagnostic | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Partial<LogDiagnostic>;
  if (typeof candidate.summary !== 'string' || !candidate.summary.trim()) {
    return undefined;
  }
  if (typeof candidate.code !== 'string' || !isLogDiagnosticCode(candidate.code)) {
    return undefined;
  }
  if (typeof candidate.severity !== 'string' || !isLogDiagnosticSeverity(candidate.severity)) {
    return undefined;
  }

  const diagnostic: LogDiagnostic = {
    code: candidate.code,
    severity: candidate.severity,
    summary: candidate.summary
  };

  if (typeof candidate.line === 'number' && Number.isFinite(candidate.line)) {
    diagnostic.line = Math.floor(candidate.line);
  }
  if (typeof candidate.eventType === 'string' && candidate.eventType.trim()) {
    diagnostic.eventType = candidate.eventType;
  }

  return diagnostic;
}

export function normalizeLogTriageSummary(value: unknown): LogTriageSummary {
  if (!value || typeof value !== 'object') {
    return EMPTY_LOG_TRIAGE_SUMMARY;
  }

  const candidate = value as Partial<LogTriageSummary>;
  const reasons = Array.isArray(candidate.reasons)
    ? candidate.reasons.map(normalizeLogDiagnostic).filter((reason): reason is LogDiagnostic => Boolean(reason))
    : [];

  return {
    hasErrors: candidate.hasErrors === true || reasons.length > 0,
    primaryReason:
      typeof candidate.primaryReason === 'string' && candidate.primaryReason.trim()
        ? candidate.primaryReason
        : reasons[0]?.summary,
    reasons
  };
}

export function createUnreadableLogTriageSummary(message?: string): LogTriageSummary {
  const primaryReason = message && message.trim() ? `Log triage unavailable: ${message}` : 'Log triage unavailable';
  return {
    hasErrors: true,
    primaryReason,
    reasons: [
      {
        code: 'suspicious_error_payload',
        severity: 'warning',
        summary: primaryReason
      }
    ]
  };
}
