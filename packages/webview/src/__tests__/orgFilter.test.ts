import type { OrgItem } from '@alv/protocol/types';
import { filterOrgs, toOrgOption } from '../utils/orgFilter';

const orgs: OrgItem[] = [
  { username: 'dev@acme.com', alias: 'Acme Dev' },
  { username: 'qa@acme.com', alias: 'Acme QA' },
  { username: 'admin@globex.org' },
  { username: 'ops@globex.org', alias: '  ' }
];

describe('orgFilter', () => {
  it('keeps every org for a blank query', () => {
    expect(filterOrgs(orgs, '')).toBe(orgs);
    expect(filterOrgs(orgs, '   ')).toBe(orgs);
  });

  it('matches the alias or the username without regard to case', () => {
    expect(filterOrgs(orgs, 'acme qa').map(o => o.username)).toEqual(['qa@acme.com']);
    expect(filterOrgs(orgs, 'GLOBEX').map(o => o.username)).toEqual(['admin@globex.org', 'ops@globex.org']);
  });

  it('requires every word of the query to match', () => {
    expect(filterOrgs(orgs, 'acme dev').map(o => o.username)).toEqual(['dev@acme.com']);
    expect(filterOrgs(orgs, 'acme globex')).toEqual([]);
  });

  it('keeps the input order', () => {
    expect(filterOrgs(orgs, 'o').map(o => o.username)).toEqual([
      'dev@acme.com',
      'qa@acme.com',
      'admin@globex.org',
      'ops@globex.org'
    ]);
  });

  it('leads a row with the alias and keeps the username as secondary text', () => {
    expect(toOrgOption(orgs[0]!)).toEqual({ value: 'dev@acme.com', primary: 'Acme Dev', secondary: 'dev@acme.com' });
  });

  it('shows the username alone when the org has no alias or a blank one', () => {
    expect(toOrgOption(orgs[2]!)).toEqual({ value: 'admin@globex.org', primary: 'admin@globex.org' });
    expect(toOrgOption(orgs[3]!)).toEqual({ value: 'ops@globex.org', primary: 'ops@globex.org' });
  });
});
