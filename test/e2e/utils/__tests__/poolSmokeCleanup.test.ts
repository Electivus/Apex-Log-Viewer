import { completePoolSmokeQuery, verifyPoolSmokeCleanup } from '../poolSmokeCleanup';

const signup = {
  Id: '2SR000000000001AAA',
  Status: 'Deleted',
  CreatedById: '005000000000001AAA',
  alvPoolKey__c: 'owned-pool',
  alvSlotKey__c: 'slot-02',
  ScratchOrg: '00D000000000001AAA'
};
const expected = {
  poolKey: 'owned-pool',
  creatorId: signup.CreatedById,
  signupIds: [signup.Id],
  activeIds: ['2AS000000000001AAA'],
  orgIds: [signup.ScratchOrg]
};

test('Deleted signup history proves cleanup only when the observed signup and active absence are confirmed', () => {
  expect(verifyPoolSmokeCleanup([signup], [], expected)).toEqual([{ id: signup.Id, status: 'Deleted' }]);
  for (const signups of [
    [],
    [{ ...signup, Status: 'Active' }],
    [{ ...signup, Status: undefined }],
    [{ ...signup, CreatedById: 'different-owner' }],
    [{ ...signup, alvPoolKey__c: null }],
    [{ ...signup, alvSlotKey__c: 'unexpected-slot' }]
  ]) {
    expect(() => verifyPoolSmokeCleanup(signups, [], expected)).toThrow();
  }
  for (const active of [
    { Id: 'other', ScratchOrgInfoId: signup.Id, ScratchOrg: 'other' },
    { Id: expected.activeIds[0], ScratchOrgInfoId: 'other', ScratchOrg: 'other' },
    { Id: 'other', ScratchOrgInfoId: 'other', ScratchOrg: signup.ScratchOrg.slice(0, 15) },
    { Id: 'other' }
  ]) {
    expect(() => verifyPoolSmokeCleanup([signup], [active], expected)).toThrow();
  }
});

test('cleanup evidence rejects failed, incomplete and malformed query responses', () => {
  const success = { status: 0, result: { done: true, totalSize: 1, records: [signup] } };
  expect(completePoolSmokeQuery(success)).toEqual([signup]);
  for (const response of [
    undefined,
    { status: 1, result: success.result },
    { status: 0, result: { ...success.result, done: false } },
    { status: 0, result: { ...success.result, totalSize: 2 } },
    { status: 0, result: { ...success.result, records: [null] } },
    { status: 0, result: { ...success.result, records: {} } }
  ]) {
    expect(() => completePoolSmokeQuery(response)).toThrow();
  }
});
