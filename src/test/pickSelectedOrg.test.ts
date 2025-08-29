import assert from 'assert/strict';
import { pickSelectedOrg } from '../utils/orgs';
import type { OrgItem } from '../shared/types';

suite('pickSelectedOrg', () => {
  test('returns current when present', () => {
    const orgs: OrgItem[] = [{ username: 'foo' }, { username: 'bar', isDefaultUsername: true }];
    assert.equal(pickSelectedOrg(orgs, 'bar'), 'bar');
  });

  test('falls back to default org when current is absent', () => {
    const orgs: OrgItem[] = [{ username: 'foo' }, { username: 'bar', isDefaultUsername: true }];
    assert.equal(pickSelectedOrg(orgs), 'bar');
  });

  test('falls back to default org when current not found', () => {
    const orgs: OrgItem[] = [{ username: 'foo' }, { username: 'bar', isDefaultUsername: true }];
    assert.equal(pickSelectedOrg(orgs, 'baz'), 'bar');
  });

  test('falls back to first org when no default', () => {
    const orgs: OrgItem[] = [{ username: 'foo' }, { username: 'bar' }];
    assert.equal(pickSelectedOrg(orgs), 'foo');
    assert.equal(pickSelectedOrg(orgs, 'baz'), 'foo');
  });
});
