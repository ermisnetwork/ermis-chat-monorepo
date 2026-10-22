import acceptedFixture from './accepted_protocol_fixture.cjs';
const {accepted, processOwnAccepted} = acceptedFixture;
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
  const cid = 'team:retained-rejoin-' + (++seq), user = 'checkpoint-' + seq;
  const provider = new wasm.Provider(), identity = new wasm.Identity(provider, user);
  const groupId = new Uint8Array([255, 0, seq]);
  const group = generation ? wasm.Group.create_with_group_id(provider, identity, groupId) : wasm.Group.create_with_cid(provider,identity,cid);
  const storage = new IndexedDBEncryptionStorage(user);
  async function manager(p = provider, g = group) {
    const m = new EncryptionManager();
    m.initialized = true; m.userId = user; m.deviceId = 'device'; m.provider = p; m.identity = identity; m.storage = storage;
    const durable = await storage.loadProviderCheckpoint(user, 'device');
    m._providerDurableBase = {storage, userId:user, deviceId:'device', revision:durable.revision};
    m.groups.set(cid, g);
    m._groupGenerations.set(cid, { cid, group_generation: generation, group_id: generation ? groupId : null, status:'active', current_epoch:0, updated_at:Date.now() });
    m._collectPendingGhosts = async (_, ids = []) => ids;
    m._cleanupEvictedGhosts = async () => {};
    m.safeArchiveCurrentEpoch = async () => {};
    m.safeArchiveCurrentEpochForCid = async () => {};
    return m;
  }
  return { cid, user, provider, identity, group, groupId, storage, manager };
}
const pendingError = epoch => ({ response:{ status:503, data:{ reason:'mls_transition_pending', retryable:true, epoch, operation_id:'73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2' } } });
const protocol = p => ({ epoch:p.expected_epoch+1, group_generation:p.group_generation, group_id:p.group_id, commit:p.commit });

async function setup(generation = 1) {
  const h = harness(generation), m = await h.manager();
  m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
  const peerProvider = new wasm.Provider(), peerIdentity = new wasm.Identity(peerProvider, 'retained-peer');
  const add = h.group.add_members(h.provider, h.identity, [peerIdentity.key_package(peerProvider)]);
  const tree = h.group.export_ratchet_tree(); h.group.merge_pending_commit(h.provider);
  const peer = wasm.Group.join_with_welcome(peerProvider, add.welcome, tree);
  const priorPeerProvider = wasm.Provider.from_bytes(peerProvider.to_bytes());
  const priorPeer = generation ? wasm.Group.load_with_group_id(priorPeerProvider,h.groupId) : wasm.Group.load(priorPeerProvider,h.cid);
  const update = peer.commit_self_update_with_removals(peerProvider, peerIdentity, []); peer.merge_pending_commit(peerProvider);
  const info = { epoch: 2, group_generation: generation, group_id: generation ? h.groupId : null,
    group_info: peer.export_group_info(peerProvider, peerIdentity, true), is_stale: false };
  m._groupGenerations.get(h.cid).current_epoch = 1;
  await m._persistProviderStrict();
  await h.storage.saveGroupState(h.cid, m._groupGenerations.get(h.cid));
  await h.storage.saveMessage({ id: 'kept-'+h.cid, cid: h.cid, content_type: 'standard', text: 'retained plaintext', created_at: new Date().toISOString() });
  const snapshot = { cid:h.cid, message_id:'cipher-'+h.cid, version:'cipher-'+h.cid, kind:'application',
    message:{id:'cipher-'+h.cid,mls_epoch:2,mls_ciphertext:new Uint8Array([9])}, mls_epoch:2 };
  await h.storage.savePendingE2eeSnapshots(h.cid,[snapshot]);
  const cursor={created_at:'2026-10-06T00:00:00Z',event_id:'retained-prefix'};
  await h.storage.saveScopeSyncCursor(h.cid,cursor);
  m._loadChannelRepairState = async () => ({ status:'reset_available',fail_count:3 });
  m._saveChannelRepairState = async () => {};
  m._repairMessagesAfterStateSync = async () => ({requiresPin:true});
  m.syncAfterExternalJoin = async () => ({cid:h.cid,status:'ready',sync_state:{status:'ready',needs_retry:false}});
  m._drainArchiveUploadQueue = async () => {};
  m._uploadGroupInfo = async () => {};
  m._partialWelcomeJoin = new PartialWelcomeJoinCoordinator(h.storage);
  let calls=0, receipt={version:1,state:'outcome_unknown'};
  m.e2eeClient={ getExternalJoinReceipt:async()=>receipt, getGroupInfo:async()=>info, externalJoin:async (_type,_id,body)=>{calls++;
    const [pending]=await h.storage.listPendingMlsMutations();
    assert.ok(pending,'exact staged rejoin checkpoint exists BEFORE HTTP');
    assert.deepEqual(pending.commit,body.commit);
    assert.equal(pending.accepted,false);
    peer.process_message(peerProvider,body.commit);
    const {sha256Hex} = require('../dist/encryption/index.cjs');
    const context = accepted(m,h.cid,body.commit,body.epoch,generation);
    receipt={version:1,state:'accepted',operation_id:body.operation_id,cid:h.cid,
      epoch:body.epoch,group_generation:generation,group_id:generation?h.groupId:null,
      commit_sha256:sha256Hex(body.commit),group_info_sha256:sha256Hex(body.group_info),
      delivery_pending:false,event_id:context.acceptanceEnvelope.event_id,acceptance_context:context.acceptanceContext};
  }};
  return {...h,m,peer,peerProvider,peerIdentity,priorPeerProvider,priorPeer,info,cursor,snapshot,calls:()=>calls,receipt:()=>receipt};
}
test('owner repair checkpoints exact external rejoin before HTTP and keeps plaintext, pending ciphertext and cursor',async()=>{
  const h=await setup();
  const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  assert.equal(result.status,'healthy'); assert.equal(h.calls(),1); assert.equal(h.m.getEpoch(h.cid),3);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  assert.equal((await h.storage.loadMessage('kept-'+h.cid)).text,'retained plaintext');
  assert.deepEqual(await h.storage.loadPendingE2eeSnapshots(h.cid),[h.snapshot]);
  assert.deepEqual(await h.storage.loadScopeSyncCursor(h.cid),h.cursor);
  const loaded=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  const g=wasm.Group.load_with_group_id(loaded,h.groupId);assert.equal(Number(g.epoch()),3);
  const ciphertext=h.peer.create_message(h.peerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'after-retained-rejoin'})));
  assert.equal((await receiveApplication(h.m, h.cid, ciphertext)).text,'after-retained-rejoin');
  assert.equal((await h.storage.loadExternalJoinReadiness(h.cid)).first_decryptable_epoch,3);
});

async function restart(h) {
  const p=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  const g=wasm.Group.load_with_group_id(p,h.groupId),m=await h.manager(p,g);
  m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  m.e2eeClient={...h.m.e2eeClient,getExternalJoinReceipt:async()=>h.receipt()};
  m._partialWelcomeJoin=new PartialWelcomeJoinCoordinator(h.storage);
  for(const pending of await h.storage.listPendingMlsMutations())m._pendingMlsMutations.set(h.cid,pending);
  m._uploadGroupInfo=async()=>{};m.safeArchiveCurrentEpochForCid=async()=>{};
  return m;
}
test('lost rejoin response survives provider reload; exact own receipt merges and retires once',async()=>{
  const h=await setup(),send=h.m.e2eeClient.externalJoin;
  h.m.e2eeClient.externalJoin=async(...args)=>{await send(...args);h.m.e2eeClient.getExternalJoinReceipt=async()=>{throw new Error('receipt offline');};throw new Error('response lost');};
  const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  assert.equal(result.status,'failed');
  const [pending]=await h.storage.listPendingMlsMutations();assert.equal(pending.accepted,false);
  assert.equal(pending.retained_rejoin.version,1);assert.ok(pending.retained_rejoin.provider_before.length);
  await assert.rejects(() => h.m._prepareApplicationSend({e2ee_group_id: h.cid, payload: {text:'must block pending candidate'}}), /outcome_pending/);
  const m=await restart(h);
  await processOwnAccepted(m, h.cid,protocol(pending));await processOwnAccepted(m, h.cid,protocol(pending));
  assert.equal(m.getEpoch(h.cid),3);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  const cipher=h.peer.create_message(h.peerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'exact-ack'})));
  assert.equal((await receiveApplication(m, h.cid, cipher)).text,'exact-ack');
});
test('final checkpoint abort after acceptance recovers candidate without another HTTP send',async()=>{
  const h=await setup();const save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);let writes=0;
  h.storage.saveMlsMutationCheckpoint=async cp=>{if(++writes===3)throw new Error('final checkpoint aborted');return save(cp);};
  const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  assert.equal(result.status,'failed');assert.equal(h.calls(),1);
  const [pending]=await h.storage.listPendingMlsMutations();assert.equal(pending.accepted,true);
  h.storage.saveMlsMutationCheckpoint=save;const m=await restart(h);let sent=0;
  m.e2eeClient={externalJoin:async()=>{sent++;}};
  await m._resumePendingMlsMutations();assert.equal(sent,0);assert.equal(m.getEpoch(h.cid),3);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('preparation write failure sends no HTTP and preserves old provider/group/cache/ciphertext',async()=>{
  const h=await setup(),before=await h.storage.loadProviderState(h.user,'device');
  h.storage.saveMlsMutationCheckpoint=async()=>{throw new Error('disk unavailable');};
  const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  assert.equal(result.status,'failed');assert.equal(h.calls(),0);assert.equal(h.m.getEpoch(h.cid),1);
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),before);
  assert.deepEqual(await h.storage.loadPendingE2eeSnapshots(h.cid),[h.snapshot]);
  assert.equal((await h.storage.loadMessage('kept-'+h.cid)).text,'retained plaintext');
});
test('definitive initial rejection restores reloaded old group; retry rejection keeps unknown original candidate',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async(_t,_i,body)=>{
    const {sha256Hex}=require('../dist/encryption/index.cjs');
    h.m.e2eeClient.getExternalJoinReceipt=async()=>({version:1,state:'rejected',operation_id:body.operation_id,cid:h.cid,
      epoch:body.epoch,group_generation:1,group_id:h.groupId,commit_sha256:sha256Hex(body.commit),group_info_sha256:sha256Hex(body.group_info),
      event_id:null,acceptance_context:null,delivery_pending:false,rejection_reason:'head_conflict',rejected_at:new Date().toISOString()});
    throw {response:{status:403}};
  };
  // Provider snapshots encode a HashMap: byte order is not semantic identity.
  // Prove restoration with the actual prior ratchet, not serialized key order.
  const priorCipher=h.priorPeer.create_message(h.priorPeerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'prior-ratchet'})));
  const before=h.provider.to_bytes();
  const seedGuard=h.m._providerWriteGuard();
  await h.storage.saveProviderState(h.user,'device',before,seedGuard);
  await h.m._readProviderWrite(before,seedGuard,()=>{});
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'failed');
  assert.equal(h.m.getEpoch(h.cid),1);
  const restoredProvider=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.ok(JSON.stringify(providerEntries(before))===JSON.stringify(providerEntries(await h.storage.loadProviderState(h.user,'device'))), 'every retained key/value survives rollback independent of map iteration order');
  const restoredGroup=wasm.Group.load_with_group_id(restoredProvider,h.groupId);
  assert.equal(Number(restoredGroup.epoch()),1);
  assert.deepEqual(restoredGroup.group_id(),h.groupId);
  assert.equal((await receiveApplication(h.m, h.cid, priorCipher)).text,'prior-ratchet');
  assert.ok((await prepareFixtureSend(h.m, h.cid, 'restored state remains usable')).mls_ciphertext.length > 0);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  h.m.e2eeClient.externalJoin=async()=>{throw new Error('unknown response');};
  await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  const [pending]=await h.storage.listPendingMlsMutations();const m=await restart(h);
  m.e2eeClient={externalJoin:async(_t,_id,body)=>{assert.deepEqual(body,pending.request.body);throw {response:{status:400}};}};
  m._emitSyncState=()=>{};
  await m._resumePendingMlsMutations();
  assert.deepEqual(await h.storage.listPendingMlsMutations(),[pending]);
  await assert.rejects(() => m._prepareApplicationSend({e2ee_group_id: h.cid, payload: {text:'blocked'}}), /outcome_pending/);
});
test('provider repair gate defers concurrent sync/receive/send and preserves another group across candidate adoption',async()=>{
  const h=await setup();const second='team:retained-other',secondId=new Uint8Array([20,21,22]);
  const other=wasm.Group.create_with_group_id(h.m.provider,h.identity,secondId);
  h.m.groups.set(second,other);h.m._groupGenerations.set(second,{cid:second,group_generation:1,group_id:secondId,current_epoch:0,status:'active',updated_at:Date.now()});
  let release,entered;const pendingSend=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  const send=h.m.e2eeClient.externalJoin;h.m.e2eeClient.externalJoin=async(...args)=>{entered();await pendingSend;return send(...args);};
  const work=h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);await started;
  assert.equal(h.m.isSyncing(),true);assert.equal(h.m._isEncryptionProcessingBlockedForRoute(second,second),true);
  await assert.rejects(() => h.m._prepareApplicationSend({e2ee_group_id: second, payload: {text:'blocked during provider adoption'}}), /repair is settling/);
  let syncCalls=0;h.m._syncAndRestoreGroups=async()=>{syncCalls++;};const sync=h.m.sync();
  await Promise.resolve();assert.equal(syncCalls,0);release();await work;await sync;
  assert.equal(syncCalls,1);assert.equal(h.m.isSyncing(),false);assert.equal(h.m.getEpoch(second),0);
  const saved=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.equal(Number(wasm.Group.load_with_group_id(saved,secondId).epoch()),0);
  assert.ok((await prepareFixtureSend(h.m, second, 'other group remains usable')).mls_ciphertext.length > 0);
});
test('stale or mismatched-generation GroupInfo cannot submit a new rejoin',async()=>{
  for(const changes of [{is_stale:true},{group_generation:2},{group_id:new Uint8Array([1])}]){
    const h=await setup();h.m.e2eeClient.getGroupInfo=async()=>({...h.info,...changes});
    const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
    assert.equal(result.status,'failed');assert.equal(h.calls(),0);assert.equal(h.m.getEpoch(h.cid),1);
  }
});

// Decode only inside the test; never print provider keys or values in evidence.
function providerEntries(bytes) {
  const data=Buffer.from(bytes);let offset=0;
  const read=()=>{const n=Number(data.readBigUInt64BE(offset));offset+=8;return n;};
  const count=read(),entries=[];
  for(let i=0;i<count;i++){
    const kn=read(),vn=read(),key=data.subarray(offset,offset+kn);offset+=kn;
    const value=data.subarray(offset,offset+vn);offset+=vn;
    entries.push([key.toString('hex'),value.toString('hex')]);
  }
  assert.equal(offset,data.length);return entries.sort((a,b)=>a[0].localeCompare(b[0]));
}
test('accepted-pending HTTP transition merges exact candidate and does not retry a new commit',async()=>{
  const h=await setup(),send=h.m.e2eeClient.externalJoin;
  h.m.e2eeClient.externalJoin=async(...args)=>{await send(...args);throw pendingError(3);};
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'healthy');
  assert.equal(h.calls(),1);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  const cipher=h.peer.create_message(h.peerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'accepted-pending'})));
  assert.equal((await receiveApplication(h.m, h.cid, cipher)).text,'accepted-pending');
});
test('mismatched receipt cannot retire a saved unknown external candidate',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw new Error('unknown response');};
  await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  const [pending]=await h.storage.listPendingMlsMutations(),m=await restart(h);
  for(const changes of [{epoch:4},{group_generation:2},{group_id:new Uint8Array([7])},{commit:new Uint8Array([8])}]){
    await assert.rejects(()=>processOwnAccepted(m, h.cid,{...protocol(pending),...changes}),/outcome_pending/);
    assert.equal((await h.storage.listPendingMlsMutations()).length,1);
  }
});
test('session switch before preparation sends no request and does not install into another account',async()=>{
  const h=await setup();h.m.e2eeClient.getGroupInfo=async()=>{h.m.userId='other-session';return h.info;};
  await assert.rejects(()=>h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid),{code:'recovery_scope_changed'});
  assert.equal(h.calls(),0);assert.equal(h.m.getEpoch(h.cid),1);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('session switch during HTTP retains old-account candidate without merging into new session',async()=>{
  const h=await setup(),send=h.m.e2eeClient.externalJoin;
  h.m.e2eeClient.externalJoin=async(...args)=>{await send(...args);h.m.userId='other-session';};
  await assert.rejects(()=>h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid),{code:'recovery_scope_changed'});
  const [pending]=await h.storage.listPendingMlsMutations();assert.equal(pending.accepted,false);
  const m=await restart(h);await processOwnAccepted(m, h.cid,protocol(pending));
  assert.equal(m.getEpoch(h.cid),3);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('incomplete replay after accepted rejoin is reported failed rather than healthy',async()=>{
  const h=await setup();h.m.syncAfterExternalJoin=async()=>({status:'joined_pending',sync_state:{needs_retry:true,error:'protocol pending'}});
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'failed');
  assert.equal(h.m.getEpoch(h.cid),3);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('new join boundary retains unrepaired historical ciphertext and displays previously cached plaintext',async()=>{
  const h=await setup();await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  h.m._isEncryptionProcessingBlockedForRoute=()=>false;
  const plain={id:'kept-'+h.cid,mls_epoch:2,group_generation:1,mls_ciphertext:new Uint8Array([9]),created_at:'2026-10-06T00:00:00Z'};
  const missing={...plain,id:'missing-'+h.cid};
  const result=await h.m.decryptApplicationMessages(h.cid,[plain,missing]);
  assert.equal(result.decrypted.length,1);assert.equal(result.decrypted[0].text,'retained plaintext');
  assert.equal(result.buffered.length,1);assert.equal(result.buffered[0].id,missing.id);
});
test('initial HTTP timeout does not roll back an outcome that may already be accepted',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw {response:{status:408}};};
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'failed');
  assert.equal((await h.storage.listPendingMlsMutations()).length,1);
  await assert.rejects(() => h.m._prepareApplicationSend({e2ee_group_id: h.cid, payload: {text:'blocked'}}), /outcome_pending/);
});

test('legacy generation-zero retained group rejoins without explicit GroupId and survives reload',async()=>{
  const h=await setup(0);
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'healthy');
  const p=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.equal(Number(wasm.Group.load(p,h.cid).epoch()),3);
  const cipher=h.peer.create_message(h.peerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'legacy-rejoined'})));
  assert.equal((await receiveApplication(h.m, h.cid, cipher)).text,'legacy-rejoined');
});

// Receive through the real atomic public path with the installed logical generation.
let receivedApplicationSequence = 0;
async function receiveApplication(manager, cid, ciphertext) {
  const result = await manager.decryptApplicationMessages(cid, [{id: 'verified-fixture-' + (++receivedApplicationSequence),
    cid, created_at: new Date().toISOString(), mls_ciphertext: ciphertext,
    group_generation: manager._groupGenerations.get(cid)?.group_generation || 0}]);
  assert.equal(result.buffered.length, 0);
  assert.equal(result.decrypted.length, 1);
  assert.equal(result.decrypted[0].mls_application_checkpoint_version, 1);
  return result.decrypted[0];
}

async function prepareFixtureSend(manager, cid, text) {
  const id = 'fixture-send-' + (++receivedApplicationSequence), now = Date.now();
  return manager._prepareApplicationSend({message_id: id, cid, e2ee_group_id: cid,
    channel_type: 'team', channel_id: cid.slice(5), text, payload: {text},
    group_generation: manager._groupGenerations.get(cid)?.group_generation || 0,
    retry_count: 0, status: 'sending', created_at: now, updated_at: now});
}

// DEC043: real binary and IDB faults at the retained writer boundaries.
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('retained rejoin legacy custom adapter rejects before fetch, mutation or HTTP',async()=>{
  for(const missing of ['providerCheckpointCASVersion','mlsMutationCheckpointVersion','verifyMlsMutationCheckpoint']){
    const h=await setup(),before=h.m.provider.to_bytes();let fetched=0;
    h.storage[missing]=undefined;h.m.e2eeClient.getGroupInfo=async()=>{fetched++;return h.info;};
    await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'client_upgrade_required'});
    assert.equal(fetched,0);assert.equal(h.calls(),0);assert.deepEqual(h.m.provider.to_bytes(),before);
    assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  }
});
test('provider changed while readiness loads cannot overwrite intervening persisted private key',async()=>{
  const h=await setup(),load=h.storage.loadExternalJoinReadiness.bind(h.storage);let winner;
  h.storage.loadExternalJoinReadiness=async cid=>{
    h.identity.key_package(h.m.provider);await h.m._persistProviderStrict();winner=h.m.provider.to_bytes();
    return load(cid);
  };
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'recovery_scope_changed'});
  assert.equal(h.calls(),0);assert.deepEqual(h.m.provider.to_bytes(),winner);
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),winner);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('new writer queued before retained admission is preserved instead of adopting its revision for stale snapshot',async()=>{
  const h=await setup(),queue=h.m._withProviderMutation.bind(h.m);let intercepted=false,winner;
  h.m._withProviderMutation=async work=>{
    if(!intercepted){intercepted=true;h.identity.key_package(h.m.provider);await h.m._persistProviderStrict();winner=h.m.provider.to_bytes();}
    return queue(work);
  };
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'recovery_scope_changed'});
  assert.equal(h.calls(),0);assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),winner);
  assert.deepEqual(h.m.provider.to_bytes(),winner);
});
test('remote CAS winner blocks retained candidate before HTTP without replacing winning durable provider',async()=>{
  const h=await setup(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage),other=new IndexedDBEncryptionStorage(h.user);
  let winning;
  h.storage.saveMlsMutationCheckpoint=async cp=>{
    const loaded=await other.loadProviderCheckpoint(h.user,'device');
    const provider=wasm.Provider.from_bytes(loaded.provider_bytes);h.identity.key_package(provider);winning=provider.to_bytes();
    await other.saveProviderState(h.user,'device',winning,{expected_revision:loaded.revision,next_revision:'retained-remote-winner'});
    provider.free();return save(cp);
  };
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'provider_checkpoint_conflict'});
  assert.equal(h.calls(),0);assert.deepEqual(await other.loadProviderState(h.user,'device'),winning);
  assert.equal((await other.listPendingMlsMutations()).length,0);
  assert.throws(()=>h.m.provider,{code:'provider_persistence_uncertain'});await other.close();
});
test('checkpoint activation completes before next queued writer observes the candidate',async()=>{
  const h=await setup(),verify=h.storage.verifyMlsMutationCheckpoint.bind(h.storage),entered=deferred(),gate=deferred();let reads=0;
  h.storage.verifyMlsMutationCheckpoint=async cp=>{if(++reads===1){entered.resolve();await gate.promise;}return verify(cp);};
  const work=h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),outcome=work.catch(e=>e);await entered.promise;
  assert.equal(h.calls(),0);assert.equal(h.m._pendingMlsMutations.size,0);
  const queued=h.m._withProviderMutation(async provider=>{
    assert.ok(h.m._pendingMlsMutations.get(h.cid),'candidate installed before queue release');
    assert.notEqual(provider,h.provider);assert.equal(h.m.getEpoch(h.cid),3);
    h.identity.key_package(provider);
  });
  gate.resolve();await queued;await outcome;
  assert.equal((await h.storage.listPendingMlsMutations()).length,1);
});
test('acceptance checkpoint abort leaves active and durable journal unaccepted',async()=>{
  const h=await setup(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);let writes=0,staged;
  h.storage.saveMlsMutationCheckpoint=async cp=>{if(++writes===2){staged=h.m._activeProvider;throw Error('acceptance abort');}return save(cp);};
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),/acceptance abort/);
  assert.equal(h.m._activeProvider,staged);assert.equal(h.m._pendingMlsMutations.get(h.cid).accepted,false);
  assert.equal((await h.storage.listPendingMlsMutations())[0].accepted,false);assert.equal(h.calls(),1);
  const m=await restart(h);await processOwnAccepted(m,h.cid,protocol((await h.storage.listPendingMlsMutations())[0]));
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('final checkpoint abort never merges or rolls back active accepted provider',async()=>{
  const h=await setup(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);let writes=0,active,bytes;
  h.storage.saveMlsMutationCheckpoint=async cp=>{if(++writes===3){active=h.m._activeProvider;bytes=active.to_bytes();throw Error('final clone abort');}return save(cp);};
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),/final clone abort/);
  assert.equal(h.m._activeProvider,active);assert.deepEqual(h.m.provider.to_bytes(),bytes);
  assert.equal(h.m._pendingMlsMutations.get(h.cid).accepted,true);
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),bytes);
  const m=await restart(h);let sent=0;m.e2eeClient={externalJoin:async()=>{sent++;}};await m._resumePendingMlsMutations();
  assert.equal(sent,0);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
for(const field of ['marker','pending','readiness'])test('consistent retained readback detects tampered '+field+' without activation',async()=>{
  const h=await setup(),verify=h.storage.verifyMlsMutationCheckpoint.bind(h.storage);let reads=0,active;
  h.storage.verifyMlsMutationCheckpoint=async cp=>{
    if(++reads===(field==='readiness'?3:1)){
      active=h.m._activeProvider;const db=await h.storage.openDB();
      await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','groups'],'readwrite');
        if(field==='marker')tx.objectStore('groups').put({...cp.marker,current_epoch:100},h.cid);
        else if(field==='pending')tx.objectStore('meta').put({...cp.pending,accepted:true},'mls_mutation:v1:'+h.cid);
        else tx.objectStore('meta').put({...cp.readiness,first_decryptable_epoch:100},'external_join_readiness:'+h.cid);
        tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
      });
    }
    return verify(cp);
  };
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'provider_persistence_uncertain'});
  assert.equal(h.m._activeProvider,active);assert.throws(()=>h.m.provider,{code:'provider_persistence_uncertain'});
  assert.equal(h.calls(),field==='readiness'?1:0);
});
test('unknown initial conflict keeps exact journal and does not restore old provider',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw {response:{status:409}};};
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid));
  const [pending]=await h.storage.listPendingMlsMutations();assert.equal(pending.accepted,false);
  assert.equal(h.m._pendingMlsMutations.get(h.cid).accepted,false);assert.notEqual(h.m._activeProvider,h.provider);
});
test('definitive rejection after an intervening writer cannot restore the whole old provider',async()=>{
  const h=await setup();let winner;
  h.m.e2eeClient.externalJoin=async()=>{
    h.identity.key_package(h.m.provider);await h.m._persistProviderStrict();winner=h.m.provider.to_bytes();
    throw {response:{status:403}};
  };
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'recovery_scope_changed'});
  assert.deepEqual(h.m.provider.to_bytes(),winner);assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),winner);
  assert.equal((await h.storage.listPendingMlsMutations()).length,1);
});
for(const field of ['client','e2eeClient','_wasmArtifactSha256','_allowExpiredJoinTreeLeaves'])test('retained preparation fences '+field+' replacement',async()=>{
  const h=await setup(),original=h.m._activeProvider;h.m.e2eeClient.getGroupInfo=async()=>{
    h.m[field]=field==='_allowExpiredJoinTreeLeaves'?true:field==='_wasmArtifactSha256'?'other-artifact':{};return h.info;
  };
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),{code:'recovery_scope_changed'});
  assert.equal(h.m._activeProvider,original);assert.equal(h.calls(),0);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('late retained HTTP cannot clear replacement work or sync gate',async()=>{
  const h=await setup(),entered=deferred(),gate=deferred();h.m.e2eeClient.externalJoin=async()=>{entered.resolve();await gate.promise;};
  const old=h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),outcome=old.catch(e=>e.code);await entered.promise;
  const replacement=Promise.resolve(),resolve=()=>{};h.m.e2eeClient={};h.m._retainedRejoinWork=replacement;
  h.m._syncGateResolve=resolve;h.m._syncPromise=replacement;h.m._syncing=true;gate.resolve();
  assert.equal(await outcome,'recovery_scope_changed');assert.equal(h.m._retainedRejoinWork,replacement);
  assert.equal(h.m._syncGateResolve,resolve);assert.equal(h.m._syncPromise,replacement);assert.equal(h.m.isSyncing(),true);
});
test('epoch stale fallback uses retained atomic checkpoint and accepted abort resumes without another HTTP',async()=>{
  const h=await setup(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);let writes=0;
  h.storage.saveMlsMutationCheckpoint=async cp=>{if(++writes===3)throw Error('epoch stale final abort');return save(cp);};
  await assert.rejects(()=>h.m._rejoinEpochStaleGroup('team',h.cid.slice(5),h.cid),/epoch stale final abort/);
  assert.equal(h.calls(),1);assert.equal((await h.storage.listPendingMlsMutations())[0].accepted,true);
  assert.equal((await h.storage.loadMessage('kept-'+h.cid)).text,'retained plaintext');
  h.storage.saveMlsMutationCheckpoint=save;const m=await restart(h);let sent=0;m.e2eeClient={externalJoin:async()=>{sent++;}};
  await m._resumePendingMlsMutations();assert.equal(sent,0);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('epoch stale fallback refuses healthy result when accepted transition replay remains incomplete',async()=>{
  const h=await setup();h.m.syncAfterExternalJoin=async()=>({status:'joined_pending',sync_state:{needs_retry:true}});
  await assert.rejects(()=>h.m._rejoinEpochStaleGroup('team',h.cid.slice(5),h.cid),/sync remains incomplete/);
  assert.equal(h.calls(),1);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});

test('GroupInfo wait reacquires group handle replaced by another admitted writer',async()=>{
  const h=await setup(),original=h.m.groups.get(h.cid);
  h.m.e2eeClient.getGroupInfo=async()=>{
    await h.m._withProviderMutation(async(provider,current,replace)=>{
      const next=wasm.Provider.from_bytes(provider.to_bytes()),group=wasm.Group.load_with_group_id(next,h.groupId);
      original.free();replace(next);h.m.groups.set(h.cid,group);
    });return h.info;
  };
  assert.equal(await h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid),3);
  assert.equal(h.calls(),1);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('late retained archive completion cannot continue into replacement scope',async()=>{
  const h=await setup(),started=deferred(),gate=deferred();let archive=0;
  h.m._uploadGroupInfo=async()=>assert.fail("atomic GI must not be uploaded again");
  h.m.safeArchiveCurrentEpochForCid=async()=>{archive++;started.resolve();await gate.promise;};
  const work=h.m._publishRetainedRejoin('team',h.cid.slice(5),h.cid),outcome=work.catch(e=>e.code);
  await started.promise;h.m.e2eeClient={};gate.resolve();
  assert.equal(await outcome,'recovery_scope_changed');assert.equal(archive,1);
});

for(const target of ['marker','journal'])test('acceptance continuation cannot overwrite changed target '+target,async()=>{
  const h=await setup(),coordinator=h.m._retainedRejoin(),persist=coordinator.c.persistCheckpoint;let writes=0;
  coordinator.c.persistCheckpoint=async(cp,...args)=>{
    writes++;const base=await persist(cp,...args);
    if(cp.pending?.accepted){
      if(target==='marker'){
        const marker={...h.m._groupGenerations.get(h.cid),current_epoch:4};
        h.m._groupGenerations.set(h.cid,marker);await h.storage.saveGroupState(h.cid,marker);
      }else h.m._pendingMlsMutations.get(h.cid).request.body={...cp.pending.request.body,epoch:99};
    }
    return base;
  };
  await assert.rejects(()=>coordinator.start('team',h.cid.slice(5),h.cid),{code:'recovery_scope_changed'});
  assert.equal(writes,2);assert.equal(h.calls(),1);
  assert.equal((await h.storage.listPendingMlsMutations())[0].accepted,true);
  if(target==='marker'){assert.equal(h.m._groupGenerations.get(h.cid).current_epoch,4);assert.equal((await h.storage.loadGroupState(h.cid)).current_epoch,4);}
  else assert.equal(h.m._pendingMlsMutations.get(h.cid).request.body.epoch,99);
});

test('scope replacement after verified final activation cannot return old success or free the installed provider',async()=>{
  const h=await setup(),coordinator=h.m._retainedRejoin(),persist=coordinator.c.persistCheckpoint;let installed;
  coordinator.c.persistCheckpoint=async(cp,...args)=>{
    const base=await persist(cp,...args);
    if(!cp.pending){installed=h.m._activeProvider;h.m.e2eeClient={};}
    return base;
  };
  await assert.rejects(()=>coordinator.start('team',h.cid.slice(5),h.cid),{code:'recovery_scope_changed'});
  assert.equal(h.m._activeProvider,installed);assert.ok(installed.to_bytes().length);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  assert.equal((await h.storage.loadExternalJoinReadiness(h.cid)).first_decryptable_epoch,3);
});

test('resume scope error is propagated without a late non-ready callback for the replacement',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw Error('unknown outcome');};
  await assert.rejects(()=>h.m._rejoinRetainingState('team',h.cid.slice(5),h.cid));
  let emitted=0;h.m._emitSyncState=()=>{emitted++;};
  h.m.e2eeClient={getExternalJoinReceipt:async()=>({state:'outcome_unknown'}),externalJoin:async()=>{h.m.e2eeClient={};throw Error('old retry failure');}};
  await assert.rejects(()=>h.m._resumePendingMlsMutations(),{code:'recovery_scope_changed'});
  assert.equal(emitted,0);assert.equal((await h.storage.listPendingMlsMutations()).length,1);
});

test('retained owner repair never schedules a second GI upload after atomic acceptance',async()=>{
 const h=await setup();let uploads=0;h.m._uploadGroupInfo=async()=>{uploads++;};
 const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
 assert.equal(result.status,'healthy');assert.equal(uploads,0);
});
test('own commit event cannot bypass canonical retained GI digest binding',async()=>{
 const h=await setup(),send=h.m.e2eeClient.externalJoin;
 h.m.e2eeClient.externalJoin=async(...args)=>{await send(...args);h.m.e2eeClient.getExternalJoinReceipt=async()=>{throw Error('receipt offline');};throw Error('response lost');};
 await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
 const [pending]=await h.storage.listPendingMlsMutations(),m=await restart(h);
 m.e2eeClient.getExternalJoinReceipt=async()=>({...h.receipt(),group_info_sha256:'f'.repeat(64)});
 await assert.rejects(()=>processOwnAccepted(m,h.cid,protocol(pending)));
 assert.equal((await h.storage.listPendingMlsMutations())[0].accepted,false);
});
