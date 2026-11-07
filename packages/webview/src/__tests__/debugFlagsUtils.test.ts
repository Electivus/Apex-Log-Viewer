import type { DebugFlagUser } from '@alv/protocol/debugFlagsTypes';
import { getApplyBlocker, orderUsersForPicker } from '../utils/debugFlags';

const user = (id: string, username: string): DebugFlagUser => ({ id, name: id, username, active: true });

describe('orderUsersForPicker', () => {
  const ada = user('ada', 'ada@example.com');
  const me = user('me', 'Me@Example.com');
  const zed = user('zed', 'zed@example.com');

  it('puts the authenticated user first and keeps the rest in the host order', () => {
    expect(orderUsersForPicker([ada, zed, me], 'me@example.com')).toEqual([me, ada, zed]);
  });

  it('matches the username without regard to case or surrounding space', () => {
    expect(orderUsersForPicker([ada, me], '  ME@EXAMPLE.COM ')[0]).toBe(me);
  });

  it('leaves the list alone when the authenticated user is not in it, or there is none', () => {
    const users = [ada, zed];
    expect(orderUsersForPicker(users, 'me@example.com')).toBe(users);
    expect(orderUsersForPicker(users, undefined)).toBe(users);
    expect(orderUsersForPicker(users, '')).toBe(users);
  });

  it('does not mutate its input', () => {
    const users = [ada, me];
    orderUsersForPicker(users, 'me@example.com');
    expect(users).toEqual([ada, me]);
  });
});

describe('getApplyBlocker', () => {
  it('names the first thing missing, target before debug level', () => {
    expect(getApplyBlocker({ hasTarget: false, hasDebugLevel: false })).toBe('noTarget');
    expect(getApplyBlocker({ hasTarget: true, hasDebugLevel: false })).toBe('noDebugLevel');
  });

  it('reports nothing when Apply can run', () => {
    expect(getApplyBlocker({ hasTarget: true, hasDebugLevel: true })).toBeUndefined();
  });
});
