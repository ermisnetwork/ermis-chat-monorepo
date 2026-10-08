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
  function manager(p = provider, g = group) {
    const m = new EncryptionManager();
    m.initialized = true; m.userId = user; m.deviceId = 'device'; m.provider = p; m.identity = identity; m.storage = storage;
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
  const h = harness(generation), m = h.manager();
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
  await h.storage.saveProviderState(h.user, 'device', h.provider.to_bytes());
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
  let calls=0;
  m.e2eeClient={ getGroupInfo:async()=>info, externalJoin:async (_type,_id,body)=>{calls++;
    const [pending]=await h.storage.listPendingMlsMutations();
    assert.ok(pending,'exact staged rejoin checkpoint exists BEFORE HTTP');
    assert.deepEqual(pending.commit,body.commit);
    assert.equal(pending.accepted,false);
    peer.process_message(peerProvider,body.commit);
  }};
  return {...h,m,peer,peerProvider,peerIdentity,priorPeerProvider,priorPeer,info,cursor,snapshot,calls:()=>calls};
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
  assert.equal(h.m.decryptMessage(h.cid,ciphertext).payload.text,'after-retained-rejoin');
  assert.equal((await h.storage.loadExternalJoinReadiness(h.cid)).first_decryptable_epoch,3);
});

async function restart(h) {
  const p=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  const g=wasm.Group.load_with_group_id(p,h.groupId),m=h.manager(p,g);
  m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  m._partialWelcomeJoin=new PartialWelcomeJoinCoordinator(h.storage);
  for(const pending of await h.storage.listPendingMlsMutations())m._pendingMlsMutations.set(h.cid,pending);
  m._uploadGroupInfo=async()=>{};m.safeArchiveCurrentEpochForCid=async()=>{};
  return m;
}
test('lost rejoin response survives provider reload; exact own receipt merges and retires once',async()=>{
  const h=await setup(),send=h.m.e2eeClient.externalJoin;
  h.m.e2eeClient.externalJoin=async(...args)=>{await send(...args);throw new Error('response lost');};
  const result=await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  assert.equal(result.status,'failed');
  const [pending]=await h.storage.listPendingMlsMutations();assert.equal(pending.accepted,false);
  assert.equal(pending.retained_rejoin.version,1);assert.ok(pending.retained_rejoin.provider_before.length);
  assert.throws(()=>h.m.encryptMessage(h.cid,{text:'must block pending candidate'}),/outcome_pending/);
  const m=await restart(h);
  await m.processOwnMlsCommit(h.cid,protocol(pending));await m.processOwnMlsCommit(h.cid,protocol(pending));
  assert.equal(m.getEpoch(h.cid),3);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  const cipher=h.peer.create_message(h.peerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'exact-ack'})));
  assert.equal(m.decryptMessage(h.cid,cipher).payload.text,'exact-ack');
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
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw {response:{status:403}};};
  // Provider snapshots encode a HashMap: byte order is not semantic identity.
  // Prove restoration with the actual prior ratchet, not serialized key order.
  const priorCipher=h.priorPeer.create_message(h.priorPeerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'prior-ratchet'})));
  const before=h.provider.to_bytes();
  await h.storage.saveProviderState(h.user,'device',before);
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'failed');
  assert.equal(h.m.getEpoch(h.cid),1);
  const restoredProvider=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.ok(JSON.stringify(providerEntries(before))===JSON.stringify(providerEntries(await h.storage.loadProviderState(h.user,'device'))), 'every retained key/value survives rollback independent of map iteration order');
  const restoredGroup=wasm.Group.load_with_group_id(restoredProvider,h.groupId);
  assert.equal(Number(restoredGroup.epoch()),1);
  assert.deepEqual(restoredGroup.group_id(),h.groupId);
  assert.equal(h.m.decryptMessage(h.cid,priorCipher).payload.text,'prior-ratchet');
  assert.doesNotThrow(()=>h.m.encryptMessage(h.cid,{text:'restored state remains usable'}));
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  h.m.e2eeClient.externalJoin=async()=>{throw new Error('unknown response');};
  await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  const [pending]=await h.storage.listPendingMlsMutations();const m=await restart(h);
  m.e2eeClient={externalJoin:async(_t,_id,body)=>{assert.deepEqual(body,pending.request.body);throw {response:{status:400}};}};
  m._emitSyncState=()=>{};
  await m._resumePendingMlsMutations();
  assert.deepEqual(await h.storage.listPendingMlsMutations(),[pending]);
  assert.throws(()=>m.encryptMessage(h.cid,{text:'blocked'}),/outcome_pending/);
});
test('provider repair gate defers concurrent sync/receive/send and preserves another group across candidate adoption',async()=>{
  const h=await setup();const second='team:retained-other',secondId=new Uint8Array([20,21,22]);
  const other=wasm.Group.create_with_group_id(h.m.provider,h.identity,secondId);
  h.m.groups.set(second,other);h.m._groupGenerations.set(second,{cid:second,group_generation:1,group_id:secondId,current_epoch:0,status:'active',updated_at:Date.now()});
  let release,entered;const pendingSend=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  const send=h.m.e2eeClient.externalJoin;h.m.e2eeClient.externalJoin=async(...args)=>{entered();await pendingSend;return send(...args);};
  const work=h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);await started;
  assert.equal(h.m.isSyncing(),true);assert.equal(h.m._isEncryptionProcessingBlockedForRoute(second,second),true);
  assert.throws(()=>h.m.encryptMessage(second,{text:'blocked during provider adoption'}),/repair is settling/);
  let syncCalls=0;h.m._syncAndRestoreGroups=async()=>{syncCalls++;};const sync=h.m.sync();
  await Promise.resolve();assert.equal(syncCalls,0);release();await work;await sync;
  assert.equal(syncCalls,1);assert.equal(h.m.isSyncing(),false);assert.equal(h.m.getEpoch(second),0);
  const saved=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.equal(Number(wasm.Group.load_with_group_id(saved,secondId).epoch()),0);
  assert.doesNotThrow(()=>h.m.encryptMessage(second,{text:'other group remains usable'}));
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
  assert.equal(h.m.decryptMessage(h.cid,cipher).payload.text,'accepted-pending');
});
test('mismatched receipt cannot retire a saved unknown external candidate',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw new Error('unknown response');};
  await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid);
  const [pending]=await h.storage.listPendingMlsMutations(),m=await restart(h);
  for(const changes of [{epoch:4},{group_generation:2},{group_id:new Uint8Array([7])},{commit:new Uint8Array([8])}]){
    await assert.rejects(()=>m.processOwnMlsCommit(h.cid,{...protocol(pending),...changes}),/outcome_pending/);
    assert.equal((await h.storage.listPendingMlsMutations()).length,1);
  }
});
test('session switch before preparation sends no request and does not install into another account',async()=>{
  const h=await setup();h.m.e2eeClient.getGroupInfo=async()=>{h.m.userId='other-session';return h.info;};
  await assert.rejects(()=>h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid),/session changed/);
  assert.equal(h.calls(),0);assert.equal(h.m.getEpoch(h.cid),1);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('session switch during HTTP retains old-account candidate without merging into new session',async()=>{
  const h=await setup(),send=h.m.e2eeClient.externalJoin;
  h.m.e2eeClient.externalJoin=async(...args)=>{await send(...args);h.m.userId='other-session';};
  await assert.rejects(()=>h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid),/session changed/);
  const [pending]=await h.storage.listPendingMlsMutations();assert.equal(pending.accepted,false);
  const m=await restart(h);await m.processOwnMlsCommit(h.cid,protocol(pending));
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
  const plain={id:'kept-'+h.cid,mls_epoch:2,mls_ciphertext:new Uint8Array([9]),created_at:'2026-10-06T00:00:00Z'};
  const missing={...plain,id:'missing-'+h.cid};
  const result=await h.m.decryptApplicationMessages(h.cid,[plain,missing]);
  assert.equal(result.decrypted.length,1);assert.equal(result.decrypted[0].text,'retained plaintext');
  assert.equal(result.buffered.length,1);assert.equal(result.buffered[0].id,missing.id);
});
test('initial HTTP timeout does not roll back an outcome that may already be accepted',async()=>{
  const h=await setup();h.m.e2eeClient.externalJoin=async()=>{throw {response:{status:408}};};
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'failed');
  assert.equal((await h.storage.listPendingMlsMutations()).length,1);
  assert.throws(()=>h.m.encryptMessage(h.cid,{text:'blocked'}),/outcome_pending/);
});

test('legacy generation-zero retained group rejoins without explicit GroupId and survives reload',async()=>{
  const h=await setup(0);
  assert.equal((await h.m._resetEncryptedChannelState('team',h.cid.slice(5),h.cid,h.cid)).status,'healthy');
  const p=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.equal(Number(wasm.Group.load(p,h.cid).epoch()),3);
  const cipher=h.peer.create_message(h.peerProvider,h.peerIdentity,new TextEncoder().encode(JSON.stringify({text:'legacy-rejoined'})));
  assert.equal(h.m.decryptMessage(h.cid,cipher).payload.text,'legacy-rejoined');
});
