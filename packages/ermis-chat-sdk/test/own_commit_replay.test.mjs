import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const require = createRequire(import.meta.url);
const { EncryptionManager, IndexedDBEncryptionStorage } = require('../dist/index.cjs');
const { PartialWelcomeJoinCoordinator } = require('../dist/encryption/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
await init({ module_or_path: fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)) });
let seq = 0;
function harness(generation = 1) {
  const cid = 'team:checkpoint-' + (++seq), user = 'checkpoint-' + seq;
  const provider = new wasm.Provider(), identity = new wasm.Identity(provider, user);
  const groupId = new Uint8Array([255, 0, seq]);
  const group = generation ? wasm.Group.create_with_group_id(provider, identity, groupId) : wasm.Group.create_with_cid(provider,identity,cid);
  const storage = new IndexedDBEncryptionStorage(user);
  function manager(p = provider, g = group) {
    const m = new EncryptionManager();
    m.initialized = true; m.userId = user; m.deviceId = 'device'; m.provider = p; m.identity = identity; m.storage = storage;
    m.groups.set(cid, g);
    m._groupGenerations.set(cid, { cid, group_generation: generation, group_id: generation ? groupId : null, status:'active', current_epoch:0, updated_at:Date.now() });
    m._collectPendingGhosts = async (_, ids = []) => ids;
    m._cleanupEvictedGhosts = async () => {};
    m.safeArchiveCurrentEpoch = async () => {};
    return m;
  }
  return { cid, user, provider, identity, group, groupId, storage, manager };
}
const pendingError = epoch => ({ response:{ status:503, data:{ reason:'mls_transition_pending', retryable:true, epoch, operation_id:'73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2' } } });
const protocol = p => ({ epoch:p.expected_epoch+1, group_generation:p.group_generation, group_id:p.group_id, commit:p.commit });
for (const generation of [0, 1]) {
  test(`real WASM generation ${generation}: own logical device tag cannot skip an unapplied Commit from a different leaf`, async () => {
    const h = harness(generation), m = h.manager();
    m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
    m.safeArchiveCurrentEpochForCid = async () => {};
    const peerProvider = new wasm.Provider(), peerIdentity = new wasm.Identity(peerProvider, h.user);
    const add = h.group.add_members(h.provider, h.identity, [peerIdentity.key_package(peerProvider)]);
    const tree = h.group.export_ratchet_tree(); h.group.merge_pending_commit(h.provider);
    const peer = wasm.Group.join_with_welcome(peerProvider, add.welcome, tree);
    const commit = peer.commit_self_update_with_removals(peerProvider, peerIdentity, []);
    peer.merge_pending_commit(peerProvider);
    const start = { created_at: new Date().toISOString(), event_id: 'before-own-tag' };
    const event = { type: 'protocol', cid: h.cid, event_id: 'own-tag', created_at: new Date().toISOString(),
      data: { type: 'commit', user: { id: h.user }, device_id: 'device',
        epoch: 2, group_generation: generation, ...(generation ? { group_id: h.groupId } : {}), commit: commit.commit } };
    const result = await m._processChannelEvents(h.cid, [event], start);
    assert.equal(m.getEpoch(h.cid), 2);
    assert.equal(result.processedEvents, 1);
    const saved = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
    const reloaded = generation ? wasm.Group.load_with_group_id(saved, h.groupId) : wasm.Group.load(saved, h.cid);
    assert.equal(Number(reloaded.epoch()), 2);
    const ciphertext = peer.create_message(peerProvider, peerIdentity, new TextEncoder().encode(JSON.stringify({ text: 'own-tag-replayed' })));
    assert.equal(m.decryptMessage(h.cid, ciphertext).payload.text, 'own-tag-replayed');
  });
}

test('real WASM genuinely self-authored Commit without its journal is not acknowledged or numerically merged', async () => {
  const h = harness(), m = h.manager();
  m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
  const before = h.provider.to_bytes();
  const bundle = h.group.commit_self_update_with_removals(h.provider, h.identity, []);
  h.group.merge_pending_commit(h.provider);
  m.provider = wasm.Provider.from_bytes(before);
  m.groups.set(h.cid, wasm.Group.load_with_group_id(m.provider, h.groupId));
  await h.storage.saveProviderState(h.user, 'device', before);
  const savedCursor = { created_at: new Date().toISOString(), event_id: 'safe-prefix' };
  await h.storage.saveScopeSyncCursor(h.cid, savedCursor);
  const event = { type: 'protocol', cid: h.cid, event_id: 'unrecoverable-own', created_at: new Date().toISOString(),
    data: { type: 'commit', user: { id: h.user }, device_id: 'device', epoch: 1,
      group_generation: 1, group_id: h.groupId, commit: bundle.commit } };
  m.e2eeClient = { scopeSync: async () => ({ channels: { [h.cid]: {
    events: [event], next_cursor: { created_at: event.created_at, event_id: event.event_id }, has_more: false,
  } } }) };
  await assert.rejects(m._syncChannelFromCursor(h.cid, savedCursor, 100));
  assert.equal(m.getEpoch(h.cid), 0);
  assert.deepEqual(await h.storage.loadProviderState(h.user, 'device'), before);
  assert.deepEqual(await h.storage.loadScopeSyncCursor(h.cid), savedCursor);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
});

test('own-tagged malformed Commit cannot retire an unknown candidate; exact receipt still recovers after failure', async () => {
  const h = harness(), m = h.manager();
  m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
  m.e2eeClient = { keyRotation: async () => { throw new Error('lost response'); } };
  await assert.rejects(m.keyRotation(h.cid));
  const [candidate] = await h.storage.listPendingMlsMutations();
  const before = await h.storage.loadProviderState(h.user, 'device');
  await assert.rejects(m.processOwnMlsCommit(h.cid, { ...protocol(candidate), commit: new Uint8Array([1]) }));
  assert.equal(m.getEpoch(h.cid), 0);
  assert.deepEqual(await h.storage.listPendingMlsMutations(), [candidate]);
  assert.deepEqual(await h.storage.loadProviderState(h.user, 'device'), before);
  await m.processOwnMlsCommit(h.cid, protocol(candidate));
  assert.equal(m.getEpoch(h.cid), 1);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  const restored = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
  assert.equal(Number(wasm.Group.load_with_group_id(restored, h.groupId).epoch()), 1);
});
