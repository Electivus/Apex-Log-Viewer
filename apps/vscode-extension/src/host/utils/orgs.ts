import type { OrgItem } from '../../shared/types';

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

/**
 * Name a user recognises for the selected org: its alias, else its username. A selection that matches no
 * listed org is shown as typed. Returns undefined when nothing is selected.
 */
export function orgDisplayName(orgs: OrgItem[], selected: string | undefined): string | undefined {
  const trimmed = selected?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = orgs.find(o => o.username === trimmed || o.alias === trimmed);
  return match?.alias?.trim() || match?.username || trimmed;
}
