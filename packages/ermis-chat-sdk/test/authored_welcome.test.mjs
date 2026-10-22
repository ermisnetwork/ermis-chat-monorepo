import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as w from '../src/encryption/wasm/openmls_wasm.js';
import acceptedFixture from './accepted_protocol_fixture.cjs';
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex} = createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const wasmBytes = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({module_or_path: wasmBytes}); let sequence = 0;
async function fixture() {
  const user = 'authored-' + (++sequence), device = 'device', cid = 'team:' + user, storage = new IndexedDBEncryptionStorage(user);
  const m = new EncryptionManager(); Object.assign(m, {userId: user, deviceId: device, storage, _injectedWasm: w, _wasmArtifactSha256: sha256Hex(wasmBytes)});
  await m._initWasm(); await m._initIdentity();
  const p = new w.Provider(), peer = new w.Identity(p, 'peer'), kp = peer.key_package(p), group = w.Group.create_with_cid(m.provider, m.identity, cid);
  const bundle = group.add_members(m.provider, m.identity, [kp]); group.merge_pending_commit(m.provider); group.save_state(m.provider);
  m.groups.set(cid, group); m._groupGenerations.set(cid, {cid, group_generation: 0, group_id: null, current_epoch: 1, status: 'active', updated_at: Date.now()});
  await m._writeMlsMutation(cid, null);
  m.client = {baseURL: 'http://fixture', activeChannels: {}, dispatchEvent() {}}; m.e2eeClient = {}; m.initialized = true; m.ensureKeyPackagesFromServer = async () => {};
  const tree = group.export_ratchet_tree(), protocol = {type: 'welcome', user: {id: user}, device_id: device, target_user_ids: [user, 'peer'], epoch: 1, group_generation: 0, welcome: new Uint8Array(bundle.welcome), ratchet_tree: tree.to_bytes()}; tree.free();
  const options = acceptedFixture.accepted(m, cid, protocol.welcome, 1), cursor = {created_at: new Date(options.acceptanceContext.accepted_at * 1000).toISOString(), event_id: options.acceptanceContext.event_id};
  return {m, storage, user, device, cid, protocol, options, cursor, close: async () => {await storage.close(); peer.free(); p.free();}};
}
for (const poisoned of [false, true]) test(`actual creator Welcome ${poisoned ? 'repairs legacy pending' : 'replay'} retains authored proof without joining`, async () => {
  const f = await fixture(), before = f.m.provider.to_bytes();
  if (poisoned) {
    const row = f.m._welcomeRecoveryRecord(f.protocol.welcome, {...f.options, welcomeEventCursor: f.cursor});
    await f.m._recordOwnedWelcomeFailure(row, f.m._captureExternalJoinOwner(f.cid));
  }
  assert.equal(await f.m.processMlsWelcome(f.cid, f.protocol, f.options, f.cursor), 'not_targeted');
  const row = await f.storage.loadWelcomeRecoveryCheckpoint(f.cid, f.device, f.cursor.event_id);
  assert.equal(row.status, 'authored'); assert.equal(row.checkpoint.authored_device_id, f.device);
  assert.equal(await f.storage.loadExternalJoinReadiness(f.cid), null); assert.deepEqual(f.m.provider.to_bytes(), before);
  assert.equal((await f.m.refreshE2eeState(f.cid)).state, 'ready');
  assert.equal(await f.m.processMlsWelcome(f.cid, f.protocol, f.options, f.cursor), 'not_targeted');
  const restarted = new EncryptionManager(); Object.assign(restarted, {userId:f.user,deviceId:f.device,storage:new IndexedDBEncryptionStorage(f.user),_injectedWasm:w,_wasmArtifactSha256:sha256Hex(wasmBytes)});
  await restarted._initWasm();await restarted._initIdentity();await restarted._restoreGroupsLocally();restarted.client=f.m.client;restarted.e2eeClient={};restarted.initialized=true;
  assert.equal(await restarted.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'not_targeted');
  restarted.storage.welcomeAuthoredDispositionVersion=undefined;
  await assert.rejects(restarted.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),e=>e.code==='client_upgrade_required');await restarted.storage.close();
  await f.close();
});
for (const changed of ['device', 'tree', 'epoch', 'capability', 'abort']) test(`creator disposition refuses ${changed} without discarding obligation`, async () => {
  const f = await fixture();
  const row = f.m._welcomeRecoveryRecord(f.protocol.welcome, {...f.options, welcomeEventCursor: f.cursor});
  await f.m._recordOwnedWelcomeFailure(row, f.m._captureExternalJoinOwner(f.cid));
  if (changed === 'device') f.protocol.device_id = 'other-device';
  if (changed === 'tree') f.protocol.ratchet_tree = new Uint8Array([1]);
  if (changed === 'epoch') {f.protocol.epoch = 2; f.options = acceptedFixture.accepted(f.m, f.cid, f.protocol.welcome, 2);}
  if (changed === 'capability') f.storage.welcomeAuthoredDispositionVersion = undefined;
  let restore = () => {};
  if (changed === 'abort') {const save = f.storage.saveWelcomeWork.bind(f.storage); f.storage.saveWelcomeWork = async (...args) => {if (args[4].record.status === 'authored') throw Object.assign(Error('injected abort'), {checkpoint_outcome: 'aborted'}); return save(...args);}; restore = () => {f.storage.saveWelcomeWork = save;};}
  if (changed === 'device') assert.equal(await f.m.processMlsWelcome(f.cid, f.protocol, f.options, f.cursor), 'pending_external_join');
  else await assert.rejects(f.m.processMlsWelcome(f.cid, f.protocol, f.options, f.cursor));
  restore(); assert.equal((await f.storage.loadWelcomeRecoveryCheckpoint(f.cid, f.device, f.cursor.event_id)).status, 'pending_external_join');
  assert.equal((await f.storage.loadExternalJoinReadiness(f.cid)).status, 'pending_external_join'); await f.close();
});


async function generationBoundaryFixture(){
 const f=await fixture(),row=f.m._welcomeRecoveryRecord(f.protocol.welcome,{...f.options,welcomeEventCursor:f.cursor});
 await f.m._recordOwnedWelcomeFailure(row,f.m._captureExternalJoinOwner(f.cid));
 const id=globalThis.crypto.randomUUID(),groupId=Uint8Array.from({length:32},(_,i)=>i+1),group=w.Group.create_with_group_id(f.m.provider,f.m.identity,groupId);group.save_state(f.m.provider);
 f.m.groups.set(f.cid,group);f.m._groupGenerations.set(f.cid,{cid:f.cid,group_generation:1,group_id:groupId,current_epoch:0,status:'active',operation_id:id,updated_at:Date.now()});await f.m._writeMlsMutation(f.cid,null);
 const receipt={operation_id:id,operation_key:globalThis.crypto.randomUUID(),state:'activated',reason:'repair_window_open',expected_generation:0,current_generation:1,current_epoch:0,group_id:groupId,membership_version:'a'.repeat(64),activated_at:new Date().toISOString(),delivery_pending:0,retryable:false};
 f.m.e2eeClient={getMlsRebootstrapReceipt:async()=>receipt};return {...f,row,receipt};
}
test('actual generation receipt dispositions an old NoMatching Welcome without claiming it applied',async()=>{
 const f=await generationBoundaryFixture(),before=f.m.provider.to_bytes();
 assert.equal(await f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'superseded_by_generation');
 const row=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);
 assert.equal(row.status,'superseded_by_generation');assert.equal(row.group_generation,0);assert.equal(row.payload_sha256,f.row.payload_sha256);assert.equal(row.checkpoint.marker.group_generation,1);assert.equal(row.checkpoint.generation_receipt.operation_id,f.receipt.operation_id);
 assert.deepEqual(f.m.provider.to_bytes(),before);assert.equal(await f.storage.loadExternalJoinReadiness(f.cid),null);
 assert.equal(await f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'superseded_by_generation');await f.close();
});

for(const field of ['operation','from-generation','to-generation','group','epoch','state','time','membership','capability','abort'])test('generation disposition rejects '+field+' and retains the old obligation',async()=>{
 const f=await generationBoundaryFixture(),before=f.m.provider.to_bytes(),pending=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);let calls=0;
 const receipt={...f.receipt};if(field==='operation')receipt.operation_id=crypto.randomUUID();if(field==='from-generation')receipt.expected_generation=1;if(field==='to-generation')receipt.current_generation=2;if(field==='group')receipt.group_id=Uint8Array.of(9);if(field==='epoch')receipt.current_epoch=4;if(field==='state')receipt.state='preparing';if(field==='time')receipt.activated_at='bad';if(field==='membership')receipt.membership_version='bad';
 f.m.e2eeClient.getMlsRebootstrapReceipt=async()=>{calls++;return receipt;};if(field==='capability')f.storage.welcomeGenerationDispositionVersion=undefined;
 if(field==='abort'){const save=f.storage.saveWelcomeWork.bind(f.storage);f.storage.saveWelcomeWork=async(...args)=>{if(args[4].record.status==='superseded_by_generation')throw Object.assign(Error('abort'),{checkpoint_outcome:'aborted'});return save(...args);};}
 await assert.rejects(f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor));assert.equal(calls,field==='capability'?0:1);
 assert.deepEqual(await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id),pending);assert.deepEqual(f.m.provider.to_bytes(),before);await f.close();
});
test('scope replacement while generation receipt is in flight cannot disposition the old Welcome',async()=>{
 const f=await generationBoundaryFixture(),before=f.m.provider.to_bytes(),pending=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 f.m.e2eeClient.getMlsRebootstrapReceipt=async()=>{enter();await gate;return f.receipt;};const work=f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');await entered;f.m.client={activeChannels:{},dispatchEvent(){}};release();await rejected;assert.deepEqual(await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id),pending);assert.deepEqual(f.m.provider.to_bytes(),before);await f.close();
});
test('generation disposition survives lost checkpoint completion and reopened exact replay',async()=>{
 const f=await generationBoundaryFixture(),save=f.storage.saveWelcomeWork.bind(f.storage);f.storage.saveWelcomeWork=async(...args)=>{const result=await save(...args);if(args[4].record.status==='superseded_by_generation')throw Error('committed completion lost');return result;};
 await assert.rejects(f.m.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor));assert.equal(f.m._providerPersistenceUncertain,true);
 const record=await f.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id);assert.equal(record.status,'superseded_by_generation');
 const restarted=new EncryptionManager();Object.assign(restarted,{userId:f.user,deviceId:f.device,storage:new IndexedDBEncryptionStorage(f.user),_injectedWasm:w,_wasmArtifactSha256:sha256Hex(wasmBytes)});await restarted._initWasm();await restarted._initIdentity();await restarted._restoreGroupsLocally();restarted.client=f.m.client;restarted.e2eeClient={getMlsRebootstrapReceipt:async()=>{throw Error('completed proof must replay locally');}};restarted.initialized=true;
 assert.equal(await restarted.processMlsWelcome(f.cid,f.protocol,f.options,f.cursor),'superseded_by_generation');assert.deepEqual(await restarted.storage.loadWelcomeRecoveryCheckpoint(f.cid,f.device,f.cursor.event_id),record);await restarted.storage.close();await f.close();
});
