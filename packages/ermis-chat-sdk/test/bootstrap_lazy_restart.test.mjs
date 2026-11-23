import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const require = createRequire(import.meta.url);
const { EncryptionManager, IndexedDBEncryptionStorage, sha256Hex } = require('../dist/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const bytes = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({ module_or_path: bytes });
let sequence = 0;
async function fixture() {
 const user = 'lazy-' + (++sequence), cid = 'team:' + user;
 const p = new wasm.Provider(), identity = new wasm.Identity(p, user), identityBytes = identity.to_bytes();
 const group = wasm.Group.create_with_cid(p, identity, cid); group.save_state(p);
 const storage = new IndexedDBEncryptionStorage(user), marker = { cid, group_generation: 0, group_id: null, current_epoch: 0, status: 'active' };
 await storage.saveGroupState(cid, marker);
 const channel = { cid, data: { mls_enabled: true }, state: { membership: { user_id: user, channel_role: 'member', created_at: '2026-11-20T00:00:00Z' } } };
 async function manager(provider = p) {
   const m = new EncryptionManager(); m.initialized = true; m.userId = user; m.deviceId = 'device'; m.provider = provider;
   m.identity = wasm.Identity.from_bytes(provider, identityBytes); m.storage = storage;
   const durable = await storage.loadProviderCheckpoint(user, 'device');
   m._providerDurableBase = { storage, userId: user, deviceId: 'device', revision: durable.revision };
   await storage.saveIdentity(user, 'device', identityBytes);
   m._wasmArtifactSha256 = sha256Hex(bytes); m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
   m.client = { baseURL: 'https://fixture.invalid', projectId: 'project', activeChannels: { [cid]: channel } };
   m._getActiveChannel = () => channel; await m._persistProviderStrict();
   return m;
 }
 const first = await manager(); first.groups.set(cid, group); first._groupGenerations.set(cid, marker);
 return { cid, channel, storage, first, manager };
}
test('installed group alone is not a bootstrap completion; persisted milestone restores without native group', async () => {
 const f = await fixture();
 assert.equal((await f.first._restoreBootstrapMilestones([f.cid])).size, 0);
 await f.first._checkpointBootstrap(f.cid);
 const restarted = await f.manager(wasm.Provider.from_bytes(await f.storage.loadProviderState(f.first.userId, 'device')));
 const completed = await restarted._restoreBootstrapMilestones([f.cid]);
 assert.equal(completed.has(f.cid), true); assert.equal(restarted.groups.size, 0);
 await restarted._restoreInstalledGroupOnDemand(f.cid);
 assert.equal(restarted.groups.size, 1); assert.equal(Number(restarted.groups.get(f.cid).epoch()), 0);
});
test('membership, device, generation and pending operation changes cannot inherit completed work', async () => {
 const f = await fixture(); await f.first._checkpointBootstrap(f.cid);
 f.channel.state.membership.created_at = '2026-11-21T00:00:00Z';
 assert.equal((await f.first._restoreBootstrapMilestones([f.cid])).size, 0);
 f.channel.state.membership.created_at = '2026-11-20T00:00:00Z';
 f.first.deviceId = 'replacement'; assert.equal((await f.first._restoreBootstrapMilestones([f.cid])).size, 0);
 f.first.deviceId = 'device'; f.first._pendingMlsMutations.set(f.cid, { kind: 'retained' });
 assert.equal((await f.first._restoreBootstrapMilestones([f.cid])).size, 0);
 f.first._pendingMlsMutations.clear();
 await f.storage.saveGroupState(f.cid, { cid: f.cid, group_generation: 1, group_id: [1], status: 'active' });
 assert.equal((await f.first._restoreBootstrapMilestones([f.cid])).size, 0);
});
test('simultaneous decrypt/protocol demand coalesces the existing installed-group restore', async () => {
 const f = await fixture(), m = await f.manager();
 let release, calls = 0;
 const load = f.storage.loadGroupState.bind(f.storage);
 f.storage.loadGroupState = async cid => { calls++; await new Promise(done => { release = done; }); return load(cid); };
 const a = m._restoreInstalledGroupOnDemand(f.cid), b = m._restoreInstalledGroupOnDemand(f.cid);
 await new Promise(done => setImmediate(done)); assert.equal(calls, 1);
 release(); await Promise.all([a, b]);
});

test('known manual recovery block cannot inherit a completed bootstrap milestone', async () => {
 const f = await fixture(); await f.first._checkpointBootstrap(f.cid);
 f.first._recoveryControls.set(f.cid, { group_generation: 0, recovery_action: 'manual_intervention_required' });
 assert.equal((await f.first._restoreBootstrapMilestones([f.cid])).size, 0);
});

test('lazy restore and an unrelated owned provider replacement serialize without losing the demand', async () => {
 const f = await fixture(), m = await f.manager();
 let release, reading;
 const entered = new Promise(done => { reading = done; });
 const load = f.storage.loadGroupState.bind(f.storage);
 f.storage.loadGroupState = async cid => {
   reading(); await new Promise(done => { release = done; }); return load(cid);
 };
 const restore = m._restoreInstalledGroupOnDemand(f.cid);
 // Observe failure immediately too, so the RED attempt cannot leak an unhandled rejection.
 const restored = restore.then(() => null, error => error);
 await entered;
 const replacement = m._withProviderMutation(async (provider, current, replace) => {
   current(); replace(wasm.Provider.from_bytes(provider.to_bytes()));
 });
 await new Promise(done => setImmediate(done));
 release(); await replacement;
 assert.equal(await restored, null);
 assert.equal(m.groups.has(f.cid), true);
 assert.equal(m.getEpoch(f.cid), 0);
});

test('lazy restore still rejects a replaced membership during its IndexedDB read', async () => {
 const f = await fixture(), m = await f.manager();
 let release, reading;
 const entered = new Promise(done => { reading = done; });
 const load = f.storage.loadGroupState.bind(f.storage);
 f.storage.loadGroupState = async cid => {
   reading(); await new Promise(done => { release = done; }); return load(cid);
 };
 const restore = m._restoreInstalledGroupOnDemand(f.cid);
 const rejected = assert.rejects(restore, { code: 'recovery_scope_changed' });
 await entered; f.channel.state.membership.created_at = '2026-11-23T00:00:00Z'; release();
 await rejected;
 assert.equal(m.groups.has(f.cid), false);
});
