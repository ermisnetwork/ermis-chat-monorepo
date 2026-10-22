const assert = require('node:assert/strict');
const test = require('node:test');
const { EncryptionManager } = require('../dist/index.cjs');
const { IndexedDBEncryptionStorage } = require('../dist/index.cjs');
const fs = require('node:fs');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
let wasm, sequence = 0;
test.before(async () => {
  wasm = await import('../src/encryption/wasm/openmls_wasm.js');
  await wasm.default({module_or_path: fs.readFileSync(require.resolve('../src/encryption/wasm/openmls_wasm_bg.wasm'))});
});

const operationId = '73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2';
async function harness(error) {
  const manager = new EncryptionManager();
  const calls = { create: 0 };
  manager.initialized = true;
  manager.userId = 'rotation-fixture-' + (++sequence); manager.deviceId = 'fixture';
  manager.provider = new wasm.Provider(); manager.identity = new wasm.Identity(manager.provider, manager.userId);
  manager.storage = new IndexedDBEncryptionStorage(manager.userId);
  manager._providerDurableBase = {storage:manager.storage,userId:manager.userId,deviceId:manager.deviceId,revision:null};
  manager._injectedWasm = wasm; manager._restoreOrCreateProvider = async () => {}; await manager._initWasm();
  const group = wasm.Group.create_with_cid(manager.provider, manager.identity, 'team:test');
  const peerProvider = new wasm.Provider(), peer = new wasm.Identity(peerProvider, 'peer');
  group.add_members(manager.provider, manager.identity, [peer.key_package(peerProvider)]); group.merge_pending_commit(manager.provider);
  const prepare = manager._prepareMlsMutation.bind(manager);
  manager._prepareMlsMutation = (cid, admit, work) => prepare(cid, admit, (...args) => { calls.create++; return work(...args); });
  manager.groups.set('team:test', group);
  manager._groupGenerations.set('team:test', {cid:'team:test',group_generation:0,group_id:null,status:'active',current_epoch:1});
  manager.e2eeClient = { keyRotation: async (_, __, body) => {
    assert.equal(body.epoch, 1);
    if (error) throw error;
  } };
  manager._requireCompositeCommitMethods = () => {};
  manager._collectPendingGhosts = async () => [];
  manager._cleanupEvictedGhosts = async () => {};
  manager.safeArchiveCurrentEpoch = async () => {};
  await manager._writeMlsMutation('team:test', null);
  return { manager, calls };
}
function pending(epoch = 2) {
  return { response: { status: 503, data: { reason: 'mls_transition_pending', retryable: true, operation_id: operationId, epoch } } };
}
test('accepted pending rotation merges and saves the original commit exactly once', async () => {
  const { manager, calls } = await harness(pending());
  assert.deepEqual(await manager.keyRotation('team:test'), { epoch: 2, delivery_pending: true, operation_id: operationId });
  assert.equal(calls.create, 1); assert.equal(manager.getEpoch('team:test'), 2);
  assert.equal((await manager.storage.listPendingMlsMutations()).length, 0);
  const restored = wasm.Provider.from_bytes(await manager.storage.loadProviderState(manager.userId,manager.deviceId));
  assert.equal(Number(wasm.Group.load(restored,'team:test').epoch()),2);
});
test('ordinary rotation keeps its existing response shape', async () => {
  const { manager } = await harness();
  assert.deepEqual(await manager.keyRotation('team:test'), { epoch: 2 });
});
for (const [name, error] of [
  ['generic outage', { response: { status: 503, data: { code: 'concierge_unavailable' } } }],
  ['wrong accepted epoch', pending(3)],
  ['invalid receipt identity', { response: { status: 503, data: { ...pending().response.data, operation_id: 'invalid' } } }],
  ['authorization failure', { response: { status: 401, data: pending().response.data } }],
]) {
  test(`${name} is never treated as accepted`, async () => {
    const { manager, calls } = await harness(error);
    await assert.rejects(manager.keyRotation('team:test'), actual => actual === error);
    assert.equal(calls.create, 1); assert.equal(manager.getEpoch('team:test'), 1);
    const [journal] = await manager.storage.listPendingMlsMutations();
    assert.equal(journal.accepted,false);
    assert.equal(manager.groups.get('team:test').has_pending_commit(),true);
  });
}
