import acceptedFixture from './accepted_protocol_fixture.cjs';
const {accepted, processOwnAccepted} = acceptedFixture;
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  async function manager(p = provider, g = group) {
    const m = new EncryptionManager();
    m.initialized = true; m.userId = user; m.deviceId = 'device'; m.provider = p; m.identity = identity; m.storage = storage;
    const durable = await storage.loadProviderCheckpoint(user, 'device');
    m._providerDurableBase = {storage, userId:user, deviceId:'device', revision:durable.revision};
    m.groups.set(cid, g);
    m._groupGenerations.set(cid, await storage.loadGroupState(cid) || { cid, group_generation: generation, group_id: generation ? groupId : null, status:'active', current_epoch:0, updated_at:Date.now() });
    m._collectPendingGhosts = async (_, ids = []) => ids;
    m._cleanupEvictedGhosts = async () => {};
    m.safeArchiveCurrentEpoch = async () => {};
    m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
    if(!await storage.loadIdentity(user,'device')) await storage.saveIdentity(user,'device',identity.to_bytes());
    if(!await storage.loadGroupState(cid)) await m._writeMlsMutation(cid,null);
    return m;
  }
  return { cid, user, provider, identity, group, groupId, storage, manager };
}
const pendingError = epoch => ({ response:{ status:503, data:{ reason:'mls_transition_pending', retryable:true, epoch, operation_id:'73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2' } } });
const protocol = p => ({ epoch:p.expected_epoch+1, group_generation:p.group_generation, group_id:p.group_id, commit:p.commit });
for (const generation of [0, 1]) {
  test(`generation ${generation}: prepared Welcome tree matches next-epoch GI without activating the owner`, async () => {
    const h = harness(generation), m = await h.manager();
    const recipientProvider = new wasm.Provider(), recipient = new wasm.Identity(recipientProvider, 'tree-recipient');
    const bundle = h.group.commit_member_add_with_removals(h.provider, h.identity, [], [recipient.key_package(recipientProvider)]);
    const before = new Uint8Array(h.provider.to_bytes()), epoch = Number(h.group.epoch());
    const oldTree = h.group.export_ratchet_tree();
    const tree = m._exportPreparedMutationTree(h.provider, h.group);
    const validation = wasm.Group.validate_group_info_with_policy(h.provider, h.identity, bundle.group_info, false);
    const sha = bytes => createHash('sha256').update(bytes).digest();
    assert.deepEqual(sha(tree), Buffer.from(validation.ratchet_tree_sha256));
    assert.notDeepEqual(sha(oldTree.to_bytes()), sha(tree), 'old export is the pre-Commit tree');
    assert.equal(Number(validation.epoch), epoch + 1);
    assert.equal(Number(h.group.epoch()), epoch);
    assert.equal(h.group.has_pending_commit(), true);
    assert.deepEqual(new Uint8Array(h.provider.to_bytes()), before);
    const restored = wasm.Provider.from_bytes(before);
    const reopened = wasm.Group.load_with_group_id(restored, h.group.group_id());
    assert.deepEqual(m._exportPreparedMutationTree(restored, reopened), tree);
    const recipientGroup = wasm.Group.join_with_welcome_typed(recipientProvider, bundle.welcome, wasm.RatchetTree.from_bytes(tree));
    h.group.merge_pending_commit(h.provider);
    const ciphertext = h.group.create_message(h.provider, h.identity, new TextEncoder().encode('next-epoch-tree'));
    const received = recipientGroup.process_message(recipientProvider, ciphertext);
    assert.equal(new TextDecoder().decode(received.content), 'next-epoch-tree');
    received.free();
    validation.free(); oldTree.free(); reopened.free(); restored.free(); recipientGroup.free(); recipient.free(); recipientProvider.free();
  });
  test(`generation ${generation}: lost add response retains the exact next-tree request across restart`, async () => {
    const h = harness(generation), m = await h.manager();
    const recipientProvider = new wasm.Provider(), recipient = new wasm.Identity(recipientProvider, 'tree-recipient');
    m.e2eeClient = {getKeyPackagesByUserIds: async () => ({members:[{user_id:'tree-recipient',key_packages:[{device_id:'recipient-device',key_package:recipient.key_package(recipientProvider).to_bytes()}]}]})};
    m.client = {activeChannels:{[h.cid]:{addMembersE2ee:async () => {throw new Error('lost add response');}}}};
    await assert.rejects(m.addMembers('team', h.cid.slice(5), h.cid, ['tree-recipient']), /lost add response/);
    const [pending] = await h.storage.listPendingMlsMutations();
    const body = pending.request.body;
    const validation = wasm.Group.validate_group_info_with_policy(m.provider, h.identity, new Uint8Array(body.group_info), false);
    assert.deepEqual(createHash('sha256').update(new Uint8Array(body.ratchet_tree)).digest(), Buffer.from(validation.ratchet_tree_sha256));
    const restored = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
    const reopened = wasm.Group.load_with_group_id(restored, m.groups.get(h.cid).group_id());
    assert.equal(reopened.has_pending_commit(), true);
    assert.equal(Number(reopened.epoch()), 0);
    assert.deepEqual(m._exportPreparedMutationTree(restored, reopened), new Uint8Array(body.ratchet_tree));
    assert.deepEqual(await h.storage.listPendingMlsMutations(), [pending]);
    validation.free(); reopened.free(); restored.free(); recipient.free(); recipientProvider.free();
  });
}
for (const lane of ['waterfall','receive']) {
test(`real WASM historical Base64 ciphertext is normalized in ${lane}`,async()=>{
  const h=harness(),sender=await h.manager();
  const bp=new wasm.Provider(),bob=new wasm.Identity(bp,'bob');
  const bundle=h.group.add_members(h.provider,h.identity,[bob.key_package(bp)]);
  const tree=h.group.export_ratchet_tree();h.group.merge_pending_commit(h.provider);
  const bg=wasm.Group.join_with_welcome_typed(bp,bundle.welcome,tree);
  const receiver=await h.manager(bp,bg);receiver.identity=bob;receiver.userId='bob';
  receiver._providerDurableBase={storage:h.storage,userId:'bob',deviceId:'device',revision:(await h.storage.loadProviderCheckpoint('bob','device')).revision};
  receiver._injectedWasm=wasm;receiver._restoreOrCreateProvider=async()=>{};await receiver._initWasm();
  receiver._isEncryptionProcessingBlockedForRoute=()=>false;receiver._clearRepairIssue=async()=>{};
  // Explicit test-only producer: history bytes precede the receiver's checkpoint under test.
  const ciphertext=sender.groups.get(h.cid).create_message(sender.provider,sender.identity,new TextEncoder().encode(JSON.stringify({text:'encoded history fixture'})));
  sender.groups.get(h.cid).save_state(sender.provider);
  const message={id:'base64-'+lane,cid:h.cid,group_generation:1,mls_epoch:1,user:{id:h.user},created_at:'2026-10-06T00:00:00Z',mls_ciphertext:Buffer.from(ciphertext).toString('base64')};
  const result=lane==='waterfall' ? (await receiver.decryptApplicationMessages(h.cid,[message])).decrypted[0]
    : await receiver.processE2eeMessage(h.cid,message);
  assert.equal(result.text,'encoded history fixture');
});
}
for (const checkpointFailure of [false,true]) {
test(`new-generation Welcome replaces an older restored group, checkpoint failure=${checkpointFailure}`,async()=>{
  const h=harness(0),m=await h.manager();m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  m.safeArchiveCurrentEpochForCid=async()=>{};m.ensureKeyPackagesFromServer=async()=>{};
  m._partialWelcomeJoin=new PartialWelcomeJoinCoordinator(h.storage);
  const seedGuard=m._providerWriteGuard(),seedBytes=h.provider.to_bytes();
  await h.storage.saveJoinCheckpoint({user_id:h.user,device_id:'device',provider_bytes:seedBytes,cid:h.cid,generation:m._groupGenerations.get(h.cid),readiness:{cid:h.cid,status:'joined_external',reason:'manual_external_join',first_decryptable_epoch:4,updated_at:Date.now()},provider_write_guard:seedGuard});
  await m._readProviderWrite(seedBytes,seedGuard,()=>{});
  assert.equal(await m._partialWelcomeJoin.isPreJoinHistorical(h.cid,1),true);
  const ownerProvider=new wasm.Provider(),ownerIdentity=new wasm.Identity(ownerProvider,'owner');
  const id=new Uint8Array([7,8,9]);
  const ownerGroup=wasm.Group.create_with_group_id(ownerProvider,ownerIdentity,id);
  const bundle=ownerGroup.add_members(ownerProvider,ownerIdentity,[h.identity.key_package(h.provider)]);
  await m._persistProviderStrict(); // Own uploaded KP private bytes must be durable before an owned manual join.

  const tree=ownerGroup.export_ratchet_tree().to_bytes();ownerGroup.merge_pending_commit(ownerProvider);
  if(checkpointFailure){
    const save=h.storage.saveWelcomeWork.bind(h.storage);
    h.storage.saveWelcomeWork=async()=>{throw Object.assign(new Error('JOIN write failed'),{checkpoint_outcome:'aborted'});};
    await assert.rejects(m.joinGroup(bundle.welcome,tree,'owner',{cid:h.cid,group_generation:1,group_id:id}),/JOIN write failed/);
    assert.equal(m.groups.get(h.cid),h.group);
    assert.equal(m._groupGenerations.get(h.cid).group_generation,0);
    h.storage.saveWelcomeWork=save;
  }
  await m.joinGroup(bundle.welcome,tree,'owner',{cid:h.cid,group_generation:1,group_id:id});
  assert.equal(m._groupGenerations.get(h.cid).group_generation,1);
  assert.deepEqual(new Uint8Array(m.groups.get(h.cid).group_id()),id);
  assert.equal(await m._partialWelcomeJoin.isPreJoinHistorical(h.cid,1),true); // Manual join preserves unresolved prior canonical history proof; it cannot clear it from a local group alone.
  assert.equal((await h.storage.loadExternalJoinReadiness(h.cid)).first_decryptable_epoch,4);
  const p=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  assert.equal(Number(wasm.Group.load_with_group_id(p,id).epoch()),1);
});
}
for (const generation of [0,1]) {
  test(`real WASM generation ${generation}: unknown rotation survives provider reload and exact history merges once`, async () => {
    const h=harness(generation), m=await h.manager();
    m.e2eeClient={ keyRotation:async()=>{ throw new Error('response lost'); } };
    await assert.rejects(m.keyRotation(h.cid), /response lost/);
    const [pending]=await h.storage.listPendingMlsMutations();
    assert.equal(pending.accepted,false);
    assert.equal(m.getEpoch(h.cid),0);
    await assert.rejects(m.keyRotation(h.cid), /outcome_pending/);
    await assert.rejects(() => m._prepareApplicationSend({e2ee_group_id: h.cid, payload: {text:'blocked'}}), /outcome_pending/);
    const restored=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
    const g=generation ? wasm.Group.load_with_group_id(restored,h.groupId) : wasm.Group.load(restored,h.cid);
    const n=await h.manager(restored,g); n._pendingMlsMutations.set(h.cid,pending);
    await n.reconcileOwnMlsCommit(h.cid,{...protocol(pending),commit:new Uint8Array([1])});
    assert.equal(Number(g.epoch()),0);
    await n.reconcileOwnMlsCommit(h.cid,protocol(pending));
    await n.reconcileOwnMlsCommit(h.cid,protocol(pending));
    assert.equal(n.getEpoch(h.cid),1);
    assert.equal((await h.storage.listPendingMlsMutations()).length,0);
    const again=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
    const final=generation ? wasm.Group.load_with_group_id(again,h.groupId) : wasm.Group.load(again,h.cid);
    assert.equal(Number(final.epoch()),1);
  });
}
test('real accepted-pending rotation stores the merged epoch and deletes its checkpoint', async()=>{
  const h=harness(),m=await h.manager(); m.e2eeClient={keyRotation:async()=>{throw pendingError(1);}};
  const r=await m.keyRotation(h.cid); assert.equal(r.delivery_pending,true); assert.equal(r.epoch,1);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('crash after acceptance checkpoint but before final write recovers without another request', async()=>{
  const h=harness(),m=await h.manager(); m.e2eeClient={keyRotation:async()=>{throw pendingError(1);}};
  const save=h.storage.saveMlsMutationCheckpoint.bind(h.storage); let writes=0;
  h.storage.saveMlsMutationCheckpoint=async cp=>{if(++writes===3)throw new Error('crash before final checkpoint');return save(cp);};
  await assert.rejects(m.keyRotation(h.cid), /crash before final/);
  const [p]=await h.storage.listPendingMlsMutations(); assert.equal(p.accepted,true);
  h.storage.saveMlsMutationCheckpoint=save;
  const restored=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
  const group=wasm.Group.load_with_group_id(restored,h.groupId),n=await h.manager(restored,group);
  n._pendingMlsMutations.set(h.cid,p);
  await n._resumePendingMlsMutations();
  assert.equal(n.getEpoch(h.cid),1); assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('checkpoint serialization failure aborts provider, marker and journal together',async()=>{
  const h=harness();await h.storage.saveProviderState(h.user,'device',new Uint8Array([7]));
  await assert.rejects(h.storage.saveMlsMutationCheckpoint({user_id:h.user,device_id:'device',cid:h.cid,provider_bytes:new Uint8Array([9]),marker:()=>{},pending:null}));
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),new Uint8Array([7]));
  assert.equal(await h.storage.loadGroupState(h.cid),null);
});
test('failure to persist the staged Commit prevents any HTTP call',async()=>{
  const h=harness(),m=await h.manager();let sent=0;
  h.storage.saveMlsMutationCheckpoint=async()=>{throw new Error('disk unavailable');};
  m.e2eeClient={keyRotation:async()=>{sent++;}};
  await assert.rejects(m.keyRotation(h.cid),/disk unavailable/);assert.equal(sent,0);
});
test('failed unsent cancellation leaves the active staged candidate in memory and storage',async()=>{
  const h=harness(),m=await h.manager();m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  await m._prepareMlsMutation(h.cid,m._captureMlsPreparation(h.cid),(p,g)=>{
    const bundle=g.commit_self_update_with_removals(p,h.identity,[]);
    return {group:g,marker:{...m._groupGenerations.get(h.cid)},commit:bundle.commit,ghosts:[],expected_epoch:0,
      request:{kind:'rotation',channel_type:'team',channel_id:h.cid.slice(5),target_user_ids:[],body:{commit:bundle.commit,epoch:0}}};
  });
  const [pending]=await h.storage.listPendingMlsMutations();
  const save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);
  h.storage.saveMlsMutationCheckpoint=async()=>{throw Object.assign(new Error('journal delete failed'),{checkpoint_outcome:'aborted'});};
  await assert.rejects(m._rejectMlsMutation(h.cid,m._pendingMlsMutations.get(h.cid),'not_submitted'),/journal delete failed/);
  assert.equal((await h.storage.listPendingMlsMutations()).length,1);
  h.storage.saveMlsMutationCheckpoint=save;
  await m.reconcileOwnMlsCommit(h.cid,protocol(pending));
  assert.equal(m.getEpoch(h.cid),1);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
for (const selfLeft of [false,true]) {
  test(`real WASM ${selfLeft ? 'self-left eviction' : 'admin removal'} accepts pending delivery and survives reload`,async()=>{
    const h=harness(),m=await h.manager();
    const bp=new wasm.Provider(),bob=new wasm.Identity(bp,'bob');
    h.group.add_members(h.provider,h.identity,[bob.key_package(bp)]);h.group.merge_pending_commit(h.provider);
    m.client={activeChannels:{[h.cid]:{removeMembersE2ee:async()=>{throw pendingError(2);}}}};
    m.e2eeClient={commitEviction:async()=>{throw pendingError(2);}};
    await m.evictMember('team',h.cid.slice(5),h.cid,'bob',selfLeft);
    assert.equal(m.getEpoch(h.cid),2); assert.equal(m.groups.get(h.cid).members_by_user_id('bob').length,0);
    const p=wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user,'device'));
    assert.equal(Number(wasm.Group.load_with_group_id(p,h.groupId).epoch()),2);
    assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  });
}
test('prepared but unsent candidate resumes the exact saved request once, without a new Commit',async()=>{
  const h=harness(),m=await h.manager();m.e2eeClient={keyRotation:async()=>{throw new Error('crash before HTTP');}};
  await assert.rejects(m.keyRotation(h.cid));
  const [pending]=await h.storage.listPendingMlsMutations();let sends=0;
  const channel={};m._getActiveChannel=()=>channel;m._getMembershipCreatedAt=()=> '2026-10-05T00:00:00Z';
  m._syncChannelFromCursor=async()=>{};
  m.e2eeClient={keyRotation:async(_t,_id,body)=>{sends++;assert.deepEqual(body.commit,pending.commit);}};
  await m._resumePendingMlsMutations();await m._resumePendingMlsMutations();
  assert.equal(sends,1);assert.equal(m.getEpoch(h.cid),1);
});
test('authorization and retry rejection preserve the unknown original exact candidate',async()=>{
  const h=harness(),m=await h.manager();m.e2eeClient={keyRotation:async()=>{throw {response:{status:403}};}};
  await assert.rejects(m.keyRotation(h.cid));const [original]=await h.storage.listPendingMlsMutations();assert.ok(original);
  const channel={};m._getActiveChannel=()=>channel;m._getMembershipCreatedAt=()=> '2026-10-05T00:00:00Z';m._syncChannelFromCursor=async()=>{};
  m.e2eeClient={keyRotation:async()=>{throw {response:{status:400}};}};
  await m._resumePendingMlsMutations();
  assert.deepEqual(await h.storage.listPendingMlsMutations(),[original]);assert.equal(m.getEpoch(h.cid),0);
});
test('real WASM add member accepts pending and durably installs its original Commit',async()=>{
  const h=harness(),m=await h.manager();m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  const bp=new wasm.Provider(),bob=new wasm.Identity(bp,'bob');
  const kp=bob.key_package(bp).to_bytes();
  m.e2eeClient={getKeyPackagesByUserIds:async()=>({members:[{user_id:'bob',key_packages:[{device_id:'b',key_package:kp}]}]})};
  m.client={activeChannels:{[h.cid]:{addMembersE2ee:async()=>{throw pendingError(1);}}}};
  const r=await m.addMembers('team',h.cid.slice(5),h.cid,['bob']);
  assert.equal(r.delivery_pending,true);assert.equal(r.epoch,1);assert.equal(m.groups.get(h.cid).members_by_user_id('bob').length,1);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('batch topic partial response retains unknown artifacts and merges only proven successes',async()=>{
  const h=harness(),m=await h.manager();m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  const second='topic:second',id=new Uint8Array([9,8,7]);
  const g=wasm.Group.create_with_group_id(h.provider,h.identity,id);m.groups.set(second,g);
  m._groupGenerations.set(second,{cid:second,group_generation:1,group_id:id,status:'active',current_epoch:0});
  await m._writeMlsMutation(second,null);
  m._topicOwnsE2eeGroup=()=>true;
  const bp=new wasm.Provider(),bob=new wasm.Identity(bp,'bob');
  m.e2eeClient={getKeyPackagesByUserIds:async()=>({members:[{user_id:'bob',key_packages:[
    {device_id:'b',key_package:bob.key_package(bp).to_bytes()},
    {device_id:'b',key_package:bob.key_package(bp).to_bytes()},
  ]}]}),batchAddMembersToTopics:async()=>({results:[{topic_cid:h.cid,success:false,error:'delivery pending'},{topic_cid:second,success:true,epoch:1}]})};
  await m.batchAddMembersToTopics('team','parent',[h.cid,second],['bob']);
  assert.equal(m.getEpoch(h.cid),0);assert.equal(m.getEpoch(second),1);
  const [p]=await h.storage.listPendingMlsMutations();assert.equal(p.cid,h.cid);
  await m.reconcileOwnMlsCommit(h.cid,protocol(p));
  assert.equal(m.getEpoch(h.cid),1);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
test('a competing authenticated Commit resolves a lost response without merging the losing candidate',async()=>{
  const h=harness(),m=await h.manager();m._injectedWasm=wasm;m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  const bp=new wasm.Provider(),bob=new wasm.Identity(bp,'bob');
  const add=h.group.add_members(h.provider,h.identity,[bob.key_package(bp)]);
  const tree=h.group.export_ratchet_tree();h.group.merge_pending_commit(h.provider);
  const bg=wasm.Group.join_with_welcome(bp,add.welcome,tree);
  m.e2eeClient={keyRotation:async()=>{throw new Error('lost response');}};
  await assert.rejects(m.keyRotation(h.cid));
  const winner=bg.commit_self_update_with_removals(bp,bob,[]);bg.merge_pending_commit(bp);
  m.safeArchiveCurrentEpochForCid=async()=>{};m._flushPendingSnapshotsForScope=async()=>({pending:[]});
  await m.processCommit(h.cid,winner.commit,2,'bob',accepted(m,h.cid,winner.commit,2));
  assert.equal(m.getEpoch(h.cid),2);assert.equal((await h.storage.listPendingMlsMutations()).length,0);
});
for (const generation of [0, 1]) {
  test(`real WASM generation ${generation}: future Commit cannot be acknowledged before its predecessor`, async () => {
    const h = harness(generation), m = await h.manager();
    m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
    m.safeArchiveCurrentEpochForCid = async () => {};
    m._flushPendingSnapshotsForScope = async () => ({ pending: [] });
    const bp = new wasm.Provider(), bob = new wasm.Identity(bp, 'ordered-bob');
    const add = h.group.add_members(h.provider, h.identity, [bob.key_package(bp)]);
    const tree = h.group.export_ratchet_tree(); h.group.merge_pending_commit(h.provider);
    const bg = wasm.Group.join_with_welcome(bp, add.welcome, tree);
    const first = bg.commit_self_update_with_removals(bp, bob, []); bg.merge_pending_commit(bp);
    const second = bg.commit_self_update_with_removals(bp, bob, []); bg.merge_pending_commit(bp);
    await assert.rejects(m.processCommit(h.cid, second.commit, 3, 'ordered-bob', accepted(m,h.cid,second.commit,3)), error => error.code === 'mls_protocol_epoch_gap');
    assert.equal(m.getEpoch(h.cid), 1);
    // Recovery uses the restored provider AND group, applying actual predecessor bytes.
    await m.processCommit(h.cid, first.commit, 2, 'ordered-bob', accepted(m,h.cid,first.commit,2));
    await m.processCommit(h.cid, second.commit, 3, 'ordered-bob', accepted(m,h.cid,second.commit,3));
    assert.equal(m.getEpoch(h.cid), 3);
    const saved = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
    const reloaded = generation ? wasm.Group.load_with_group_id(saved, h.groupId) : wasm.Group.load(saved, h.cid);
    assert.equal(Number(reloaded.epoch()), 3);
    const text = new TextEncoder().encode(JSON.stringify({ text: 'after-ordered-commits' }));
    const ciphertext = bg.create_message(bp, bob, text);
    assert.equal((await receiveApplication(m, h.cid, ciphertext)).text, 'after-ordered-commits');
  });
}
test('real WASM future receive saves pending ciphertext before gated protocol sync and recovers the original row', async () => {
  const h = harness(), m = await h.manager();
  m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
  m._isEncryptionProcessingBlockedForRoute = () => false;
  m._expectedAadForMessage = () => undefined;
  m._recordRepairIssue = async () => {};
  m._clearRepairIssue = async () => {};
  m.safeArchiveCurrentEpochForCid = async () => {};
  m._flushPendingSnapshotsForScope = async () => ({ pending: [] });
  const bp = new wasm.Provider(), bob = new wasm.Identity(bp, 'future-sender');
  const add = h.group.add_members(h.provider, h.identity, [bob.key_package(bp)]);
  const tree = h.group.export_ratchet_tree(); h.group.merge_pending_commit(h.provider);
  const bg = wasm.Group.join_with_welcome(bp, add.welcome, tree);
  const commit = bg.commit_self_update_with_removals(bp, bob, []); bg.merge_pending_commit(bp);
  const envelope = { id: 'original-future-message', cid: h.cid, group_generation: 1, mls_epoch: 2,
    user: { id: 'future-sender' }, created_at: new Date().toISOString(),
    mls_ciphertext: bg.create_message(bp, bob, new TextEncoder().encode(JSON.stringify({ text: 'original-row-recovered' }))) };
  let requests = 0;
  m.e2eeClient = {};
  // Transport fixture delivers authenticated bytes; receive, sync exclusion,
  // ciphertext/cache/provider writes and WASM processing are actual production paths.
  m._syncAndRestoreGroups = async () => {
    requests++;
    assert.equal(m.isSyncing(), true);
    const pending = await h.storage.loadPendingE2eeSnapshots(h.cid);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].message.mls_ciphertext, envelope.mls_ciphertext);
    await m.processCommit(h.cid, commit.commit, 2, 'future-sender', accepted(m,h.cid,commit.commit,2));
    const repaired = await m.decryptApplicationMessages(h.cid, [pending[0].message]);
    assert.equal(repaired.decrypted[0].text, 'original-row-recovered');
    assert.equal(repaired.buffered.length, 0);
  };
  assert.equal(await m.processE2eeMessage(h.cid, envelope), null);
  await m._syncWorkPromise;
  assert.equal(requests, 1);
  const restored = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
  assert.equal(Number(wasm.Group.load_with_group_id(restored, h.groupId).epoch()), 2);
  assert.equal((await h.storage.loadMessage(envelope.id)).text, 'original-row-recovered');
  assert.equal((await m.processE2eeMessage(h.cid, envelope)).text, 'original-row-recovered');
  assert.equal(requests, 1);
});

for (const generation of [0, 1]) {
  test(`real WASM generation ${generation}: own logical device tag cannot skip an unapplied Commit from a different leaf`, async () => {
    const h = harness(generation), m = await h.manager();
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
    event.data.event_id = event.event_id;
    event.data.acceptance_context = {...accepted(m,h.cid,commit.commit,2,generation).acceptanceContext,event_id:event.event_id};
    const result = await m._processChannelEvents(h.cid, [event], start);
    assert.equal(m.getEpoch(h.cid), 2);
    assert.equal(result.processedEvents, 1);
    const saved = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
    const reloaded = generation ? wasm.Group.load_with_group_id(saved, h.groupId) : wasm.Group.load(saved, h.cid);
    assert.equal(Number(reloaded.epoch()), 2);
    const ciphertext = peer.create_message(peerProvider, peerIdentity, new TextEncoder().encode(JSON.stringify({ text: 'own-tag-replayed' })));
    assert.equal((await receiveApplication(m, h.cid, ciphertext)).text, 'own-tag-replayed');
  });
}

test('real WASM genuinely self-authored Commit without its journal is not acknowledged or numerically merged', async () => {
  const h = harness(), m = await h.manager();
  m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
  const before = h.provider.to_bytes();
  const bundle = h.group.commit_self_update_with_removals(h.provider, h.identity, []);
  h.group.merge_pending_commit(h.provider);
  m.provider = wasm.Provider.from_bytes(before);
  m.groups.set(h.cid, wasm.Group.load_with_group_id(m.provider, h.groupId));
  const seedGuard=m._providerWriteGuard();
  await h.storage.saveProviderState(h.user,'device',before,seedGuard);
  await m._readProviderWrite(before,seedGuard,()=>{});
  const savedCursor = { created_at: new Date().toISOString(), event_id: 'safe-prefix' };
  await h.storage.saveScopeSyncCursor(h.cid, savedCursor);
  const event = { type: 'protocol', cid: h.cid, event_id: 'unrecoverable-own', created_at: new Date().toISOString(),
    data: { type: 'commit', user: { id: h.user }, device_id: 'device', epoch: 1,
      group_generation: 1, group_id: h.groupId, commit: bundle.commit } };
  event.data.event_id = event.event_id;
  event.data.acceptance_context = {...accepted(m,h.cid,bundle.commit,1,1).acceptanceContext,event_id:event.event_id};
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
  const h = harness(), m = await h.manager();
  m._injectedWasm = wasm; m._restoreOrCreateProvider = async () => {}; await m._initWasm();
  m.e2eeClient = { keyRotation: async () => { throw new Error('lost response'); } };
  await assert.rejects(m.keyRotation(h.cid));
  const [candidate] = await h.storage.listPendingMlsMutations();
  const before = await h.storage.loadProviderState(h.user, 'device');
  await assert.rejects(processOwnAccepted(m, h.cid, { ...protocol(candidate), commit: new Uint8Array([1]) }));
  assert.equal(m.getEpoch(h.cid), 0);
  assert.deepEqual(await h.storage.listPendingMlsMutations(), [candidate]);
  assert.deepEqual(await h.storage.loadProviderState(h.user, 'device'), before);
  await processOwnAccepted(m, h.cid, protocol(candidate));
  assert.equal(m.getEpoch(h.cid), 1);
  assert.equal((await h.storage.listPendingMlsMutations()).length, 0);
  const restored = wasm.Provider.from_bytes(await h.storage.loadProviderState(h.user, 'device'));
  assert.equal(Number(wasm.Group.load_with_group_id(restored, h.groupId).epoch()), 1);
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

for (const generation of [0, 1]) {
 test(`generation ${generation}: canonical own Commit before successful add HTTP response shares the settlement owner`, async()=>{
  const h=harness(generation),m=await h.manager(),recipientProvider=new wasm.Provider(),recipient=new wasm.Identity(recipientProvider,'racing-recipient');
  m.e2eeClient={getKeyPackagesByUserIds:async()=>({members:[{user_id:'racing-recipient',key_packages:[{device_id:'recipient-device',key_package:recipient.key_package(recipientProvider).to_bytes()}]}]})};
  let posts=0,writes=0,writesAfterOwn=0;const save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);h.storage.saveMlsMutationCheckpoint=async cp=>{writes++;return save(cp);};
  m.client={activeChannels:{[h.cid]:{addMembersE2ee:async()=>{
   posts++;const pending=m._pendingMlsMutations.get(h.cid);
   await processOwnAccepted(m,h.cid,protocol(pending));writesAfterOwn=writes;
   return {};
  }}}};
  const result=await m.addMembers('team',h.cid.slice(5),h.cid,['racing-recipient']);
  assert.equal(writes,writesAfterOwn,'settled HTTP callback must not rewrite the accepted checkpoint');
  assert.equal(result.epoch,1);assert.equal(posts,1);assert.equal(m.getEpoch(h.cid),1);
  assert.equal((await h.storage.listPendingMlsMutations()).length,0);
  assert.equal((await h.storage.loadGroupState(h.cid)).current_epoch,1);
  recipient.free();recipientProvider.free();
 });
}

for (const replacement of ['device', 'new operation']) {
 test(`accepted own Commit does not let late HTTP callback adopt ${replacement}`,async()=>{
  const h=harness(),m=await h.manager(),rp=new wasm.Provider(),recipient=new wasm.Identity(rp,'scope-recipient');
  m.e2eeClient={getKeyPackagesByUserIds:async()=>({members:[{user_id:'scope-recipient',key_packages:[{device_id:'recipient-device',key_package:recipient.key_package(rp).to_bytes()}]}]}),keyRotation:async()=>({})};
  let writes=0,afterReplacement=0;const save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);h.storage.saveMlsMutationCheckpoint=async cp=>{writes++;return save(cp);};
  m.client={activeChannels:{[h.cid]:{addMembersE2ee:async()=>{
   const pending=m._pendingMlsMutations.get(h.cid);await processOwnAccepted(m,h.cid,protocol(pending));
   if(replacement==='device')m.deviceId='replacement-device';else await m.keyRotation(h.cid);
   afterReplacement=writes;return {};
  }}}};
  await assert.rejects(m.addMembers('team',h.cid.slice(5),h.cid,['scope-recipient']),e=>e.code==='recovery_scope_changed');
  assert.equal(writes,afterReplacement,'late HTTP completion writes nothing into replacement state');
  assert.equal(m.getEpoch(h.cid),replacement==='device'?1:2);
  recipient.free();rp.free();
 });
}
