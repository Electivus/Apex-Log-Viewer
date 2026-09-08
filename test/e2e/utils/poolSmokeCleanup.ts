import assert from 'node:assert/strict';

export function completePoolSmokeQuery(response: any): Record<string, any>[] {
  const result = response?.result;
  assert(response?.status === 0 && result?.done === true, 'Pool smoke query failed or was incomplete.');
  assert(
    Array.isArray(result.records) && result.totalSize === result.records.length,
    'Pool smoke query has incomplete records.'
  );
  assert(
    result.records.every((record: unknown) => record && typeof record === 'object' && !Array.isArray(record)),
    'Pool smoke query has invalid records.'
  );
  return result.records;
}

export function verifyPoolSmokeCleanup(
  signups: Record<string, any>[],
  active: Record<string, any>[],
  expected: { poolKey: string; creatorId: string; signupIds: string[]; activeIds: string[]; orgIds: string[] }
): { id: string; status: string }[] {
  const sameId = (left: unknown, right: string) => typeof left === 'string' && left.slice(0, 15) === right.slice(0, 15);
  assert(
    expected.signupIds.every(id => signups.some(signup => sameId(signup.Id, id))),
    'Observed signup is missing from cleanup history.'
  );
  assert(
    signups.every(
      signup =>
        typeof signup.Id === 'string' &&
        signup.Id.startsWith('2SR') &&
        signup.Status === 'Deleted' &&
        sameId(signup.CreatedById, expected.creatorId) &&
        signup.alvPoolKey__c === expected.poolKey &&
        signup.alvSlotKey__c === 'slot-02'
    ),
    'Signup cleanup status or ownership is unconfirmed.'
  );
  assert(
    active.every(scratch =>
      ['Id', 'ScratchOrgInfoId', 'ScratchOrg'].every(
        field => typeof scratch[field] === 'string' && scratch[field].length > 0
      )
    ),
    'Active scratch inventory has invalid identity fields.'
  );
  const signupIds = [...expected.signupIds, ...signups.map(signup => signup.Id)];
  const orgIds = [...expected.orgIds, ...signups.map(signup => signup.ScratchOrg).filter(Boolean)];
  assert(
    !active.some(
      scratch =>
        signupIds.some(id => sameId(scratch.ScratchOrgInfoId, id)) ||
        expected.activeIds.some(id => sameId(scratch.Id, id)) ||
        orgIds.some(id => sameId(scratch.ScratchOrg, id))
    ),
    'An owned active scratch remains after cleanup.'
  );
  return signups.map(signup => ({ id: signup.Id, status: signup.Status }));
}
