import { getErrorMessage } from './error';

/** The error a request throws when its AbortSignal fires. */
export function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | undefined | null)?.name === 'AbortError';
}

/** An abort, or a failure whose text says the call was canceled, which is how CLI and fetch report it. */
export function isAbortLikeError(error: unknown, message?: string): boolean {
  if (isAbortError(error)) {
    return true;
  }
  const normalized = String(message ?? getErrorMessage(error) ?? '').toLowerCase();
  return normalized.includes('abort') || normalized.includes('canceled') || normalized.includes('cancelled');
}
