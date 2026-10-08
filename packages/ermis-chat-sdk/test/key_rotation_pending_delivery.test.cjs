const assert = require('node:assert/strict');
const test = require('node:test');
const { EncryptionManager } = require('../dist/index.cjs');

const operationId = '73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2';
function harness(error) {
  const manager = new EncryptionManager();
  const calls = { clear: 0, merge: 0, create: 0, save: 0, epoch: 1 };
  manager.initialized = true;
  manager.userId = 'fixture'; manager.deviceId = 'fixture';
  manager.provider = { to_bytes: () => new Uint8Array([calls.epoch]) };
  manager.storage = {
    listPendingMlsMutations: async () => [],
    saveMlsMutationCheckpoint: async cp => { if (!cp.pending) calls.save += 1; },
  };
  manager.groups = new Map([['team:test', {
    epoch: () => calls.epoch,
    commit_self_update_with_removals: () => {
      calls.create += 1;
      return { commit: new Uint8Array([1]), group_info: new Uint8Array([2]) };
    },
    clear_pending_commit: () => { calls.clear += 1; },
    merge_pending_commit: () => { calls.merge += 1; calls.epoch += 1; },
  }]]);
  manager.e2eeClient = { keyRotation: async (_, __, body) => {
    assert.equal(body.epoch, 1);
    if (error) throw error;
  } };
  manager._requireCompositeCommitMethods = () => {};
  manager._collectPendingGhosts = async () => [];
  manager._cleanupEvictedGhosts = async () => {};
  manager._saveGroup = async () => { calls.save += 1; };
  manager._persistProvider = async () => {};
  manager.safeArchiveCurrentEpoch = async () => {};
  return { manager, calls };
}
function pending(epoch = 2) {
  return { response: { status: 503, data: { reason: 'mls_transition_pending', retryable: true, operation_id: operationId, epoch } } };
}
test('accepted pending rotation merges and saves the original commit exactly once', async () => {
  const { manager, calls } = harness(pending());
  assert.deepEqual(await manager.keyRotation('team:test'), { epoch: 2, delivery_pending: true, operation_id: operationId });
  assert.deepEqual(calls, { clear: 0, merge: 1, create: 1, save: 1, epoch: 2 });
});
test('ordinary rotation keeps its existing response shape', async () => {
  const { manager } = harness();
  assert.deepEqual(await manager.keyRotation('team:test'), { epoch: 2 });
});
for (const [name, error] of [
  ['generic outage', { response: { status: 503, data: { code: 'concierge_unavailable' } } }],
  ['wrong accepted epoch', pending(3)],
  ['invalid receipt identity', { response: { status: 503, data: { ...pending().response.data, operation_id: 'invalid' } } }],
  ['authorization failure', { response: { status: 401, data: pending().response.data } }],
]) {
  test(`${name} is never treated as accepted`, async () => {
    const { manager, calls } = harness(error);
    await assert.rejects(manager.keyRotation('team:test'), actual => actual === error);
    assert.equal(calls.merge, 0);
    assert.equal(calls.clear, error.response.status >= 400 && error.response.status < 500 ? 1 : 0);
    assert.equal(calls.epoch, 1);
  });
}
