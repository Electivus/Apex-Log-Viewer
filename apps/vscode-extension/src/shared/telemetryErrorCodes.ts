const TELEMETRY_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
  }
  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }
  return '';
}

function ownCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const raw = (error as { code?: unknown }).code;
  if (typeof raw === 'number') {
    return 'RUNTIME_RESPONSE_ERROR';
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_');
  return TELEMETRY_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

export function getTelemetryErrorCode(error: unknown, fallback = 'UNKNOWN'): string {
  const message = messageOf(error).toLowerCase();

  if (message.includes('runtime exited') || message.includes('sf electivus exited')) {
    return 'RUNTIME_EXIT';
  }
  if (message.includes('request aborted')) {
    return 'REQUEST_ABORTED';
  }
  if (message.includes('timed out') || message.includes('timeout') || message.includes('etimedout')) {
    return 'ETIMEDOUT';
  }
  if (message.includes('auth') || message.includes('invalid grant') || message.includes('access token')) {
    return 'AUTH_FAILED';
  }
  if (
    message.includes('enoent') ||
    message.includes('salesforce cli not found') ||
    message.includes('cli not found') ||
    message.includes('command not found') ||
    message.includes('program not found')
  ) {
    return 'CLI_NOT_FOUND';
  }
  if (message.includes('failed to start')) {
    return 'RUNTIME_START_FAILED';
  }
  if (
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('socket')
  ) {
    return 'NETWORK_ERROR';
  }

  return ownCodeOf(error) || fallback;
}
