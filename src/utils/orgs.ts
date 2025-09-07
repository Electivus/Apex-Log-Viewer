import * as vscode from 'vscode';
import type { OrgItem } from '../shared/types';
import { SELECTED_ORG_KEY, LEGACY_SELECTED_ORG_KEY } from '../shared/constants';

/** Restore previously selected org username from globalState, if any. */
export function restoreSelectedOrg(context: vscode.ExtensionContext): string | undefined {
  try {
    const cur = (context as any)?.globalState?.get?.(SELECTED_ORG_KEY) as string | undefined;
    if (cur !== undefined) return cur;
    // Fallback to legacy key for backward compatibility
    return (context as any)?.globalState?.get?.(LEGACY_SELECTED_ORG_KEY) as string | undefined;
  } catch {
    return undefined;
  }
}

/** Persist selected org username to globalState (best-effort). */
export function persistSelectedOrg(context: vscode.ExtensionContext, username?: string): void {
  try {
    void (context as any)?.globalState?.update?.(SELECTED_ORG_KEY, username);
  } catch {
    // ignore in tests or headless
  }
}

/** Pick a selected org given the list and an optional current value. */
export function pickSelectedOrg(orgs: OrgItem[], current?: string): string | undefined {
  const match = current ? orgs.find(o => o.username === current) : undefined;
  if (match) {
    return match.username;
  }
  const def = orgs.find(o => o.isDefaultUsername)?.username;
  return def || orgs[0]?.username || undefined;
}
