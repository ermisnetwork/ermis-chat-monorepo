const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
require('fake-indexeddb/auto'); globalThis.crypto ??= webcrypto;
const {EncryptionManager, IndexedDBEncryptionStorage} = require('../dist/encryption/index.cjs');
let wasmPromise; let unique = 0;
function actualWasm() {
  return wasmPromise ??= (async () => {
    const wasm = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));
    await wasm.default({module_or_path: fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))});
    return wasm;
  })();
}
async function fixture() {
  const wasm = await actualWasm(); const cid = `team:durable-welcome-${++unique}`;
  const a = new wasm.Provider(); const alice = new wasm.Identity(a, 'alice');
  const b = new wasm.Provider(); const bob = new wasm.Identity(b, 'bob');
  const kp = bob.key_package(b); const reference = kp.hash_ref(b);
  const group = wasm.Group.create_with_cid(a, alice, cid);
  const invite = group.add_members(a, alice, [kp]); group.merge_pending_commit(a);
  const m = new EncryptionManager(); m.userId = `bob-${unique}`; m.deviceId = 'device';
  m.storage = new IndexedDBEncryptionStorage(m.userId);
  await m.storage.saveIdentity(m.userId, m.deviceId, bob.to_bytes());
  await m.storage.saveProviderState(m.userId, m.deviceId, b.to_bytes());
  m._injectedWasm = wasm; await m._initWasm(); await m._initIdentity();
  await m._persistProviderStrict();
  m.safeArchiveCurrentEpochForCid = async () => {};
  m.ensureKeyPackagesFromServer = async () => {};
  return {m, wasm, cid, welcome: invite.welcome, reference};
}

test('actual candidate saves before publication; readback, reload and consume-once agree', async () => {
  const {m, wasm, cid, welcome, reference} = await fixture();
  const active = m.provider; const before = active.to_bytes();
  const originalSave = m.storage.saveWelcomeWork.bind(m.storage);
  let unblock, entered; const gate = new Promise(r => unblock = r); const started = new Promise(r => entered = r);
  m.storage.saveWelcomeWork = async (...args) => {
    assert.equal(m.groups.has(cid), false); assert.deepEqual(active.to_bytes(), before);
    entered(); await gate; return originalSave(...args);
  };
  const joining = m.joinGroup(welcome); await started;
  assert.equal(m.groups.has(cid), false); assert(m.identity.owns_key_package_ref(active, reference));
  assert.throws(() => m.provider, /checkpoint/);
  assert.throws(() => {m.provider = new wasm.Provider();}, /replacement/);
  let queued = false; const writing = m._withProviderMutation(async () => {queued = true;});
  await Promise.resolve(); assert.equal(queued, false);
  unblock(); const joined = await joining; await writing; assert.equal(queued, true);
  assert.equal(m.groups.get(cid), joined); assert.equal(m.identity.owns_key_package_ref(m.provider, reference), false);
  const reloaded = wasm.Provider.from_bytes(await m.storage.loadProviderState(m.userId, m.deviceId));
  assert.equal(Number(wasm.Group.load(reloaded, cid).epoch()), Number(joined.epoch()));
  await assert.rejects(m.joinGroup(welcome), error => error.code === 'NoMatchingKeyPackage' || error.name === 'WelcomeJoinFailure');
  await m.storage.close();
});

test('failed durable save and mismatched generation leave active provider/private bundle untouched', async () => {
  const {m, cid, welcome, reference} = await fixture(); const before = m.provider.to_bytes();
  await assert.rejects(m.joinGroup(welcome, undefined, undefined, {cid, group_generation: 1, group_id: new Uint8Array([99])}), /GroupId/);
  m.storage.saveWelcomeWork = async () => {throw Object.assign(Error('disk full'),{checkpoint_outcome:'aborted'});};
  await assert.rejects(m.joinGroup(welcome), /disk full/);
  assert.deepEqual(m.provider.to_bytes(), before); assert(m.identity.owns_key_package_ref(m.provider, reference));
  assert.equal(m.groups.has(cid), false); assert.equal(await m.storage.loadGroupState(cid), null);
  await m.storage.close();
});

test('synchronous second-store clone failure aborts provider/readiness writes in real IndexedDB adapter', async () => {
  const {m, cid} = await fixture(); const before = await m.storage.loadProviderState(m.userId, m.deviceId);
  const state = {cid, status: 'pending_external_join', reason: 'NoMatchingKeyPackage', updated_at: Date.now()};
  await m.storage.saveExternalJoinReadiness(state);
  await assert.rejects(m.storage.saveJoinCheckpoint({user_id: m.userId, device_id: m.deviceId,
    provider_bytes: Uint8Array.of(99), cid, readiness: null, generation: {cannotClone() {}}}));
  assert.deepEqual(await m.storage.loadProviderState(m.userId, m.deviceId), before);
  assert.deepEqual(await m.storage.loadExternalJoinReadiness(cid), state);
  assert.equal(await m.storage.loadGroupState(cid), null); await m.storage.close();
});

test('committed candidate with failed readback blocks mutation and restores from durable group after restart', async () => {
  const {m, wasm, cid, welcome} = await fixture(); const active = m.provider; const before = active.to_bytes();
  const load = m.storage.loadProviderCheckpoint.bind(m.storage), save = m.storage.saveWelcomeWork.bind(m.storage);
  m.storage.saveWelcomeWork = async (...args) => {await save(...args);throw Error('readback unavailable');};
  await assert.rejects(m.joinGroup(welcome), /readback unavailable/);
  assert.deepEqual(active.to_bytes(), before); assert.equal(m.groups.has(cid), false);
  assert.throws(() => m.provider, error => error.code === 'provider_persistence_uncertain');
  m.storage.loadProviderCheckpoint = load;
  const restored = wasm.Provider.from_bytes((await load(m.userId, m.deviceId)).provider_bytes);
  assert.equal(Number(wasm.Group.load(restored, cid).epoch()), 1);
  assert.equal((await m.storage.loadGroupState(cid)).current_epoch, 1);
  await m.storage.close();
});

test('cancel/logout while saving never publishes into another account and releases mutation queue', async () => {
  const {m, cid, welcome} = await fixture(); let entered, unblock;
  const storage = m.storage;
  const started = new Promise(r => entered = r); const gate = new Promise(r => unblock = r);
  const save = m.storage.saveWelcomeWork.bind(m.storage);
  m.storage.saveWelcomeWork = async (...args) => {entered(); await gate; return save(...args);};
  const joining = m.joinGroup(welcome); await started; m.destroy(); unblock();
  await assert.rejects(joining, e=>e.code==='recovery_scope_changed'); assert.equal(m.groups.has(cid), false); assert.equal(m.userId, null);
  assert.equal(m._providerCheckpointInFlight, false); await storage.close();
});
