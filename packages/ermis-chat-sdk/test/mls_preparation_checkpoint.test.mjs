import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex} = createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
await init({module_or_path:fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url))});
let seq=0;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(){
  const user='prepare-'+(++seq),cid='team:'+user,s=new IndexedDBEncryptionStorage(user),p=new wasm.Provider(),identity=new wasm.Identity(p,user);
  const id=new Uint8Array([43,seq]),group=wasm.Group.create_with_group_id(p,identity,id),other='team:other-'+seq;
  const otherGroup=wasm.Group.create_with_cid(p,identity,other),m=new EncryptionManager();
  Object.assign(m,{initialized:true,userId:user,deviceId:'device',storage:s,provider:p,identity,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)))});
  m._restoreOrCreateProvider=async()=>{};await m._initWasm();
  m._providerDurableBase={storage:s,userId:user,deviceId:'device',revision:null};
  await s.saveIdentity(user,'device',identity.to_bytes());
  m.groups.set(cid,group);m.groups.set(other,otherGroup);
  m._groupGenerations.set(cid,{cid,group_generation:1,group_id:id,current_epoch:0,status:'active',updated_at:1});
  m._groupGenerations.set(other,{cid:other,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1});
  await m._writeMlsMutation(cid,null);await m._writeMlsMutation(other,null);
  m._collectPendingGhosts=async()=>[];m._cleanupEvictedGhosts=async()=>{};m.safeArchiveCurrentEpoch=async()=>{};m.safeArchiveCurrentEpochForCid=async()=>{};m._uploadGroupInfo=async()=>{};
  m.client={baseURL:'http://fixture/v1',activeChannels:{[cid]:{addMembersE2ee:async()=>{},removeMembersE2ee:async()=>{}}}};
  m.e2eeClient={keyRotation:async()=>{},getKeyPackagesByUserIds:async()=>({members:[]})};
  const bytes=await s.loadProviderState(user,'device');
  return {m,s,p,identity,group,user,cid,id,other,bytes};
}
function abort(s){const old=s._writeProviderCheckpoint.bind(s);s._writeProviderCheckpoint=(tx,...args)=>{old(tx,...args);tx.abort();};return ()=>s._writeProviderCheckpoint=old;}
async function recipient(){const p=new wasm.Provider(),i=new wasm.Identity(p,'peer');return {members:[{user_id:'peer',key_packages:[{device_id:'peer',key_package:i.key_package(p).to_bytes()}]}]};}
for(const capability of ['providerCheckpointCASVersion','mlsMutationCheckpointVersion','mlsMutationSettlementVersion','saveMlsMutationCheckpoint','verifyMlsMutationCheckpoint','listPendingMlsMutations'])test(`missing ${capability} rejects every admitted preparation before private mutation/network`,async()=>{
 const h=await fixture();h.s[capability]=undefined;let reads=0;h.m.e2eeClient={getKeyPackagesByUserIds:async()=>{reads++;return recipient();},getKeyPackagesByCid:async()=>{reads++;return recipient();},getGroupInfo:async()=>{reads++;}};
 h.m._topicOwnsE2eeGroup=()=>true;h.m._resolveChannelE2eeGroupId=cid=>cid;
 const calls=[()=>h.m.keyRotation(h.cid),()=>h.m.addMembers('team',h.user,h.cid,['peer']),()=>h.m.evictMember('team',h.user,h.cid,'peer'),()=>h.m.enableE2ee('team','new','team:new',[]),()=>h.m.createE2eeChannel('team','new','team:new',[]),()=>h.m.createE2eeTopic('topic:new',[]),()=>h.m.batchAddMembersToTopics('team',h.user,[h.cid],['peer'])];
 for(const call of calls)await assert.rejects(call,e=>e.code==='client_upgrade_required');
 assert.equal(reads,0);assert.equal(h.m._activeProvider,h.p);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.equal(h.group.has_pending_commit(),false);
});
for(const writer of ['rotation','channel','topic','enable'])test(`${writer} actual preparation abort preserves active/durable bytes and no HTTP`,async()=>{
 const h=await fixture(),restore=abort(h.s);let posts=0;
 h.m.e2eeClient={keyRotation:async()=>{posts++;},getKeyPackagesByUserIds:recipient,getKeyPackagesByCid:recipient,enableE2ee:async()=>{posts++;}};
 const call=writer==='rotation'?()=>h.m.keyRotation(h.cid):writer==='channel'?()=>h.m.createE2eeChannel('team','new','team:new',['peer']):writer==='topic'?()=>h.m.createE2eeTopic('topic:new',['peer']):()=>h.m.enableE2ee('team','new','team:new',['peer']);
 await assert.rejects(call,e=>e.checkpoint_outcome==='aborted');restore();
 assert.equal(posts,0);assert.equal(h.m._activeProvider,h.p);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderState(h.user,'device'),h.bytes);
 assert.equal(h.group.has_pending_commit(),false);assert.equal(h.m._providerPersistenceUncertain,false);assert.deepEqual(await h.s.listPendingMlsMutations(),[]);assert.equal(h.m.groups.size,2);
});
for(const failure of ['unknown','readback','metadata'])test(`preparation ${failure} after real commit fails closed and restart reconciles exact journal`,async()=>{
 const h=await fixture(),save=h.s.saveMlsMutationCheckpoint.bind(h.s),verify=h.s.verifyMlsMutationCheckpoint.bind(h.s);let posts=0;
 h.m.e2eeClient.keyRotation=async()=>{posts++;};
 if(failure==='unknown')h.s.saveMlsMutationCheckpoint=async cp=>{await save(cp);throw Error('commit uncertain');};
 else h.s.verifyMlsMutationCheckpoint=async cp=>{if(failure==='readback')throw Error('read unavailable');const db=await h.s.openDB();await new Promise(r=>{const tx=db.transaction('groups','readwrite');tx.objectStore('groups').put({...cp.marker,updated_at:99},h.cid);tx.oncomplete=r;});return verify(cp);};
 await assert.rejects(h.m.keyRotation(h.cid));assert.equal(posts,0);assert.equal(h.m._activeProvider,h.p);assert.deepEqual(h.p.to_bytes(),h.bytes);assert.equal(h.group.has_pending_commit(),false);assert.equal(h.m._providerPersistenceUncertain,true);
 const [pending]=await h.s.listPendingMlsMutations();assert.equal(pending.accepted,false);assert.equal(pending.expected_epoch,0);
 h.s.saveMlsMutationCheckpoint=save;h.s.verifyMlsMutationCheckpoint=verify;
 const p=wasm.Provider.from_bytes(await h.s.loadProviderState(h.user,'device'));assert.equal(wasm.Group.load_with_group_id(p,h.id).has_pending_commit(),true);
 // Actual durable restoration, not a source snapshot rollback.
 const resumed=new EncryptionManager();Object.assign(resumed,{userId:h.user,deviceId:'device',storage:h.s,_injectedWasm:wasm,_wasmArtifactSha256:h.m._wasmArtifactSha256});await resumed._initWasm();await resumed._initIdentity();await resumed._restoreGroupsLocally();await resumed._finishMlsMutation(h.cid);assert.equal(resumed.getEpoch(h.cid),1);assert.deepEqual(await h.s.listPendingMlsMutations(),[]);
});
test('local private mutation during preparation proof survives; no candidate activation or HTTP',async()=>{
 const h=await fixture(),entered=latch(),release=latch(),save=h.s.saveMlsMutationCheckpoint.bind(h.s);let posts=0;
 h.m.e2eeClient.keyRotation=async()=>{posts++;};h.s.saveMlsMutationCheckpoint=async cp=>{entered.resolve();await release.promise;return save(cp);};
 const work=h.m.keyRotation(h.cid);await entered.promise;const kp=h.identity.key_package(h.p),ref=kp.hash_ref(h.p),winning=h.p.to_bytes();kp.free();release.resolve();
 await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.deepEqual(h.p.to_bytes(),winning);assert.equal(h.identity.owns_key_package_ref(h.p,ref),true);assert.equal(posts,0);assert.equal(h.m._providerPersistenceUncertain,true);
});
test('remote private-provider/cursor winner rejects stale preparation without overwrite',async()=>{
 const h=await fixture(),cp=await h.s.loadProviderCheckpoint(h.user,'device'),winner=wasm.Provider.from_bytes(cp.provider_bytes),i=new wasm.Identity(winner,'remote');
 const kp=i.key_package(winner),ref=kp.hash_ref(winner);kp.free();const bytes=winner.to_bytes();await h.s.saveProviderState(h.user,'device',bytes,{expected_revision:cp.revision,next_revision:'remote'});
 await h.s.saveScopeSyncCursor(h.other,{created_at:'2026-10-11T00:00:00Z',event_id:'remote'});
 await assert.rejects(h.m.keyRotation(h.cid),e=>e.code==='provider_checkpoint_conflict');assert.deepEqual(await h.s.loadProviderState(h.user,'device'),bytes);assert.equal(i.owns_key_package_ref(winner,ref),true);assert.equal((await h.s.loadScopeSyncCursor(h.other)).event_id,'remote');assert.deepEqual(await h.s.listPendingMlsMutations(),[]);
});
for(const replacement of ['same-account','different-account','group','marker','pending','transport','artifact'])test(`preparation await cannot activate or delete ${replacement} replacement`,async()=>{
 const h=await fixture(),entered=latch(),release=latch(),save=h.s.saveMlsMutationCheckpoint.bind(h.s);
 h.s.saveMlsMutationCheckpoint=async cp=>{entered.resolve();await release.promise;return save(cp);};
 const work=h.m.keyRotation(h.cid);await entered.promise;
 if(replacement==='same-account')h.m.storage=new IndexedDBEncryptionStorage(h.user);
 if(replacement==='different-account')h.m.userId='new-user';
 if(replacement==='group')h.m.groups.set(h.cid,wasm.Group.load_with_group_id(h.p,h.id));
 if(replacement==='marker')h.m._groupGenerations.set(h.cid,structuredClone(h.m._groupGenerations.get(h.cid)));
 if(replacement==='pending')h.m._pendingMlsMutations.set(h.cid,{request:{kind:'replacement'}});
 if(replacement==='transport')h.m.e2eeClient={};
 if(replacement==='artifact')h.m._wasmArtifactSha256='new';
 const group=h.m.groups.get(h.cid),pending=h.m._pendingMlsMutations.get(h.cid);release.resolve();await assert.rejects(work,e=>e.code==='recovery_scope_changed');
 assert.equal(h.m._activeProvider,h.p);assert.equal(h.m.groups.get(h.cid),group);assert.equal(h.m._pendingMlsMutations.get(h.cid),pending);assert.equal(group.has_pending_commit(),false);
});
test('KP/ghost await target replacement rejects before candidate mutation',async()=>{
 const h=await fixture(),entered=latch(),release=latch();h.m.e2eeClient.getKeyPackagesByUserIds=async()=>{entered.resolve();await release.promise;return recipient();};
 const work=h.m.addMembers('team',h.user,h.cid,['peer']);await entered.promise;const group=wasm.Group.load_with_group_id(h.p,h.id);h.m.groups.set(h.cid,group);release.resolve();await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.equal(group.has_pending_commit(),false);assert.deepEqual(h.p.to_bytes(),h.bytes);
});
test('candidate callback failure frees only candidate and retains active groups/private state',async()=>{
 const h=await fixture(),admit=h.m._captureMlsPreparation(h.cid);await assert.rejects(h.m._prepareMlsMutation(h.cid,admit,(p,g)=>{g.commit_self_update_with_removals(p,h.identity,[]);throw Error('bundle validation failed');}),/bundle validation/);
 assert.equal(h.m._activeProvider,h.p);assert.equal(h.group.has_pending_commit(),false);assert.deepEqual(await h.s.loadProviderState(h.user,'device'),h.bytes);assert.deepEqual(await h.s.listPendingMlsMutations(),[]);
});
test('candidate activation and every dependent handle install precede next queued writer',async()=>{
 const h=await fixture(),entered=latch(),release=latch(),verify=h.s.verifyMlsMutationCheckpoint.bind(h.s);
 h.s.verifyMlsMutationCheckpoint=async cp=>{const ok=await verify(cp);entered.resolve();await release.promise;return ok;};
 const rotation=h.m.keyRotation(h.cid);await entered.promise;
 const next=h.m._withProviderMutation(async p=>{assert.equal(p,h.m._activeProvider);assert.notEqual(p,h.p);assert.equal(h.m.groups.get(h.cid).has_pending_commit(),true);assert.equal(h.m.getEpoch(h.other),0);assert.equal((await h.s.listPendingMlsMutations()).length,1);});
 release.resolve();await next;await rotation;assert.equal(h.m.getEpoch(h.cid),1);assert.equal(h.m.getEpoch(h.other),0);
});
for(const replacement of ['same-account','different-account','pending','sending-token'])test(`enable HTTP failure/finally retains ${replacement} replacement`,async()=>{
 const h=await fixture(),cid='team:enable-'+seq,entered=latch(),release=latch();
 h.m.e2eeClient={getKeyPackagesByCid:recipient,enableE2ee:async()=>{entered.resolve();await release.promise;throw Error('old failure');}};
 const work=h.m.enableE2ee('team','new',cid,['peer']);await entered.promise;
 if(replacement==='same-account')h.m.storage=new IndexedDBEncryptionStorage(h.user);
 if(replacement==='different-account')h.m.userId='next';
 if(replacement==='pending')h.m._pendingMlsMutations.set(cid,{request:{kind:'replacement'}});
 const token={};h.m._bootstrapSendingOwners.set(cid,token);h.m._sendingMlsMutations.add(cid);const group=h.m.groups.get(cid),pending=h.m._pendingMlsMutations.get(cid);
 release.resolve();await assert.rejects(work);assert.equal(h.m._bootstrapSendingOwners.get(cid),token);assert.equal(h.m._sendingMlsMutations.has(cid),true);assert.equal(h.m.groups.get(cid),group);assert.equal(h.m._pendingMlsMutations.get(cid),pending);assert.equal(h.m.getEpoch(cid),0);
});
// DEC084 batch external joins delegate to the canonical isolated external candidate engine.
// Its storage capability, abort/readback and group/provider/marker/transport races
// are asserted in owned_external_join and external_join_candidate_checkpoint.
for(const target of ['marker','pending'])test(`remote ${target} replacement fences initial preparation in the same actual transaction`,async()=>{
 const h=await fixture(),db=await h.s.openDB(),replacement=target==='marker'?{...h.m._groupGenerations.get(h.cid),group_generation:9}:{cid:h.cid,commit:new Uint8Array([99])};
 await new Promise(r=>{const tx=db.transaction(target==='marker'?'groups':'meta','readwrite');tx.objectStore(target==='marker'?'groups':'meta').put(replacement,target==='marker'?h.cid:'mls_mutation:v1:'+h.cid);tx.oncomplete=r;});
 await assert.rejects(h.m.keyRotation(h.cid),e=>e.code==='provider_checkpoint_conflict'&&e.checkpoint_outcome==='aborted');assert.deepEqual(await h.s.loadProviderState(h.user,'device'),h.bytes);assert.equal(h.group.has_pending_commit(),false);assert.deepEqual(target==='marker'?await h.s.loadGroupState(h.cid):(await h.s.listPendingMlsMutations())[0],replacement);
});
test('owned unrelated private-package checkpoint before preparation survives staging, settlement and reload',async()=>{
 const h=await fixture(),kp=h.identity.key_package(h.p),ref=kp.hash_ref(h.p);kp.free();await h.m._persistProviderStrict();await h.m.keyRotation(h.cid);
 const durable=wasm.Provider.from_bytes(await h.s.loadProviderState(h.user,'device'));assert.equal(h.identity.owns_key_package_ref(durable,ref),true);assert.equal(h.identity.owns_key_package_ref(h.m._activeProvider,ref),true);assert.equal(h.m.getEpoch(h.other),0);assert.equal(h.m.getEpoch(h.cid),1);
});

for(const generation of [0,7])test(`bootstrap admission refuses existing generation ${generation} marker without a group`,async()=>{
 const h=await fixture(),cid='team:retired-'+seq;const marker={cid,group_generation:generation,group_id:generation?new Uint8Array([7]):null,current_epoch:4,status:'active',updated_at:1};h.m._groupGenerations.set(cid,marker);let reads=0;h.m.e2eeClient.getKeyPackagesByUserIds=async()=>{reads++;return recipient();};
 await assert.rejects(h.m.createE2eeChannel('team','retired',cid,['peer']),e=>e.code==='mls_group_already_installed');assert.equal(reads,0);assert.equal(h.m._groupGenerations.get(cid),marker);assert.deepEqual(h.p.to_bytes(),h.bytes);
});
for(const replacement of ['group','marker'])test(`enable GI confirmation cannot settle ${replacement} replacement`,async()=>{
 const h=await fixture(),cid='team:confirm-'+seq,entered=latch(),release=latch();h.m.e2eeClient={getKeyPackagesByCid:recipient,enableE2ee:async()=>({}),getGroupInfo:async()=>{entered.resolve();await release.promise;const p=h.m._pendingMlsMutations.get(cid);return {is_stale:false,epoch:p.expected_epoch+1,group_generation:p.group_generation,group_id:p.group_id,group_info:p.request.body.group_info};}};
 const work=h.m.enableE2ee('team','confirm',cid,['peer']);await entered.promise;
 if(replacement==='group')h.m.groups.set(cid,wasm.Group.load(h.m._activeProvider,cid));else h.m._groupGenerations.set(cid,structuredClone(h.m._groupGenerations.get(cid)));
 const group=h.m.groups.get(cid),marker=h.m._groupGenerations.get(cid),pending=h.m._pendingMlsMutations.get(cid);release.resolve();await assert.rejects(work,e=>e.code==='recovery_scope_changed');assert.equal(h.m.groups.get(cid),group);assert.equal(h.m._groupGenerations.get(cid),marker);assert.equal(h.m._pendingMlsMutations.get(cid),pending);assert.equal((await h.s.listPendingMlsMutations())[0].accepted,false);
});
