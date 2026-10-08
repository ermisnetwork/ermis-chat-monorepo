const assert = require('node:assert/strict');
const test = require('node:test');
const { EncryptionManager, E2eeClient, Channel } = require('../dist/index.cjs');
const cid = 'team:mutation-generation';
const groupId = Uint8Array.from([255, 0, 42, 7]);
function harness(generation = 1, storedId = groupId, actualId = groupId) {
  const manager = new EncryptionManager();
  const calls = { requests: [], stage: 0, merge: 0, epoch: 1 };
  const group = {
    epoch: () => calls.epoch,
    group_id: () => actualId,
    members_by_user_id: () => [{}],
    commit_self_update_with_removals: () => {
      calls.stage += 1;
      return { commit: new Uint8Array([1]), group_info: new Uint8Array([2]) };
    },
    commit_member_removals: () => {
      calls.stage += 1;
      return { commit: new Uint8Array([1]), group_info: new Uint8Array([2]) };
    },
    clear_pending_commit: () => {},
    merge_pending_commit: () => { calls.merge += 1; calls.epoch += 1; },
  };
  manager.initialized = true;
  manager.provider = { to_bytes: () => new Uint8Array([calls.epoch]) };
  manager.identity = {};
  manager.storage = { listPendingMlsMutations: async () => [], saveMlsMutationCheckpoint: async () => {} };
  manager.userId = 'alice';
  manager.groups = new Map([[cid, group]]);
  manager._groupGenerations = new Map([[cid, { cid, group_generation: generation, group_id: storedId, status: 'active' }]]);
  const record = async (...args) => calls.requests.push(args.at(-1));
  manager.e2eeClient = { keyRotation: record, commitEviction: record };
  manager.client = { activeChannels: { [cid]: { removeMembersE2ee: record } } };
  manager._requireCompositeCommitMethods = () => {};
  manager._collectPendingGhosts = async (_, extra = []) => extra;
  manager._cleanupEvictedGhosts = async () => {};
  manager._saveGroup = async () => {};
  manager._persistProvider = async () => {};
  manager.safeArchiveCurrentEpoch = async () => {};
  return { manager, calls };
}
for (const [name, invoke] of [
  ['rotation', m => m.keyRotation(cid)],
  ['admin removal', m => m.evictMember('team', 'mutation-generation', cid, 'bob')],
  ['self-left cleanup', m => m.evictMember('team', 'mutation-generation', cid, 'bob', true)],
]) {
  test(`${name} sends the installed generation and exact binary GroupId`, async () => {
    const { manager, calls } = harness(3);
    await invoke(manager);
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.requests[0].group_generation, 3);
    assert.deepEqual(calls.requests[0].group_id, groupId);
    assert.equal(calls.merge, 1);
  });
  test(`${name} rejects mismatched local GroupId before staging or sending`, async () => {
    const { manager, calls } = harness(1, groupId, new Uint8Array([9]));
    await assert.rejects(invoke(manager), /generation marker/);
    assert.equal(calls.stage, 0);
    assert.equal(calls.requests.length, 0);
  });
}
test('legacy rotation sends generation zero without inventing a GroupId', async () => {
  const { manager, calls } = harness(0, null);
  await manager.keyRotation(cid);
  assert.equal(calls.requests[0].group_generation, 0);
  assert.equal(calls.requests[0].group_id, undefined);
});
test('historical generation cannot mutate', async () => {
  const { manager, calls } = harness();
  manager._groupGenerations.get(cid).status = 'historical';
  await assert.rejects(manager.keyRotation(cid), /not active/);
  assert.equal(calls.stage, 0);
});
test('HTTP mutation codecs preserve binary GroupIds in canonical Base64', async () => {
  const api = new E2eeClient('http://fixture.invalid', 'token', 'key', 'device');
  const requests = [];
  api._post = async (_, data) => { requests.push(data); return { results: [] }; };
  const body = { commit: new Uint8Array([1]), group_info: new Uint8Array([2]), epoch: 1, group_generation: 1, group_id: groupId };
  await api.keyRotation('team', 'fixture', body);
  await api.commitEviction('team', 'fixture', { ...body, target_user_ids: ['bob'] });
  await api.batchAddMembersToTopics('team', 'fixture', { target_user_ids: ['bob'], topics: [{ ...body, topic_cid: 'topic:fixture', welcome: new Uint8Array([3]), ratchet_tree: new Uint8Array([4]) }] });
  await api.batchExternalJoinTopics('team', 'fixture', { topics: [{ ...body, topic_cid: 'topic:fixture' }] });
  for (const request of requests) {
    const value = request.topics?.[0] || request;
    assert.equal(value.group_generation, 1);
    assert.equal(value.group_id, '/wAqBw==');
  }
  const channel = Object.create(Channel.prototype);
  assert.equal(channel._encodeE2eeChannelPayload(body).group_id, '/wAqBw==');
});
