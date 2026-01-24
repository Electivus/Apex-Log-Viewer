import type { OrgItem } from '../shared/types';

/**
 * Pick a selected org given the list and an optional current value.
 */
export function pickSelectedOrg(orgs: OrgItem[], current?: string): string | undefined {
  const trimmed = typeof current === 'string' ? current.trim() : undefined;
  const match = trimmed
    ? orgs.find(o => o.username === trimmed || (o.alias ? o.alias === trimmed : false))
    : undefined;
  if (match) {
    return match.username;
  }
  const def = orgs.find(o => o.isDefaultUsername)?.username;
  return def || orgs[0]?.username || undefined;
}
