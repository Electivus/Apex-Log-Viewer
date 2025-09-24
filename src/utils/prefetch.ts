import type * as vscode from 'vscode';
import { PREFETCH_LOG_BODIES_KEY } from '../shared/constants';

/** Restore the persisted prefetch toggle state (default false on error). */
export function restorePrefetchSetting(context: vscode.ExtensionContext): boolean {
  try {
    return !!(context as any)?.globalState?.get?.(PREFETCH_LOG_BODIES_KEY);
  } catch {
    return false;
  }
}

/** Persist the prefetch toggle state (best-effort). */
export function persistPrefetchSetting(context: vscode.ExtensionContext, enabled: boolean): void {
  try {
    void (context as any)?.globalState?.update?.(PREFETCH_LOG_BODIES_KEY, enabled);
  } catch {
    // ignore in tests or headless envs
  }
}
