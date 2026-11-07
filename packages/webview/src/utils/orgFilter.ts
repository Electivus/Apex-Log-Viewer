import type { OrgItem } from '@alv/protocol/types';

export type OrgOption = {
  value: string;
  primary: string;
  secondary?: string;
};

/** The alias leads a row, with the username after it as secondary text. An org with no alias shows its username. */
export function toOrgOption(org: OrgItem): OrgOption {
  const alias = org.alias?.trim();
  return alias
    ? { value: org.username, primary: alias, secondary: org.username }
    : { value: org.username, primary: org.username };
}

/**
 * Keep the orgs whose alias or username contains every whitespace-separated word of the query, ignoring case.
 * A blank query keeps them all. The input order is kept.
 */
export function filterOrgs(orgs: OrgItem[], query: string): OrgItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return orgs;
  }
  return orgs.filter(org => {
    const haystack = `${org.alias ?? ''} ${org.username}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}
