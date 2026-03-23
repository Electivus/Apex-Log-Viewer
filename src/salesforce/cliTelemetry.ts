type CliTelemetryError = Error & { code?: string; telemetryCode?: string };

const DEFAULT_ORG_PATTERNS = [
  /no default username/i,
  /no default target org/i,
  /use -o or set a default org/i,
  /set a default org/i,
  /default org/i
];

const AUTH_REQUIRED_PATTERNS = [
  /authorize an org/i,
  /run .*org login/i,
  /not authenticated/i,
  /authentication failed/i,
  /no authorization information found/i,
  /expired access\/refresh token/i,
  /invalid_grant/i
];

function normalizeCliTelemetryCode(rawCode: unknown): string {
  const raw = String(rawCode ?? '').trim();
  if (!raw) {
    return 'UNKNOWN';
  }
  if (/^\d+$/.test(raw)) {
    return `EXIT_${raw}`;
  }
  const sanitized = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'UNKNOWN';
}

export function classifyCliOutputText(text: string): string | undefined {
  const value = String(text || '').trim();
  if (!value) {
    return undefined;
  }
  if (DEFAULT_ORG_PATTERNS.some(pattern => pattern.test(value))) {
    return 'DEFAULT_ORG_MISSING';
  }
  if (AUTH_REQUIRED_PATTERNS.some(pattern => pattern.test(value))) {
    return 'AUTH_REQUIRED';
  }
  return undefined;
}

export function classifyCliExecTelemetryCode(
  rawCode: unknown,
  stderr?: string,
  stdout?: string,
  message?: string
): string {
  const explicit = String(rawCode ?? '').trim();
  if (explicit === 'ENOENT') {
    return 'ENOENT';
  }
  if (explicit === 'ETIMEDOUT') {
    return 'ETIMEDOUT';
  }
  const classifiedFromText = classifyCliOutputText([stderr, stdout, message].filter(Boolean).join('\n'));
  if (classifiedFromText) {
    return classifiedFromText;
  }
  return normalizeCliTelemetryCode(rawCode);
}

export function createCliTelemetryError(code: string, message: string): CliTelemetryError {
  const error = new Error(message) as CliTelemetryError;
  error.code = code;
  error.telemetryCode = code;
  return error;
}

export function getCliTelemetryCode(error: unknown): string {
  const candidate = error as CliTelemetryError | undefined;
  if (candidate?.telemetryCode) {
    return normalizeCliTelemetryCode(candidate.telemetryCode);
  }
  if (candidate?.code) {
    return normalizeCliTelemetryCode(candidate.code);
  }
  return 'UNKNOWN';
}
