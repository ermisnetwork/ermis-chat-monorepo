import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const require=createRequire(import.meta.url);
const {EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=require('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
await init({module_or_path:fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url))});
let sequence=0;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(){
  const user='settlement-'+(++sequence),cid='team:'+user,id=new Uint8Array([42,sequence]);
  const storage=new IndexedDBEncryptionStorage(user),provider=new wasm.Provider(),identity=new wasm.Identity(provider,user);
  const group=wasm.Group.create_with_group_id(provider,identity,id);
  const other='team:other-'+sequence,otherGroup=wasm.Group.create_with_cid(provider,identity,other);
  async function manager(p=provider){
    const m=new EncryptionManager();m.initialized=true;m.userId=user;m.deviceId='device';m.storage=storage;m.provider=p;m.identity=identity;
    m._providerDurableBase={storage,userId:user,deviceId:'device',revision:(await storage.loadProviderCheckpoint(user,'device')).revision};
    m._injectedWasm=wasm;m._wasmArtifactSha256=sha256Hex(fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url)));m._restoreOrCreateProvider=async()=>{};await m._initWasm();
    m.groups.set(cid,p===provider?group:wasm.Group.load_with_group_id(p,id));
    m.groups.set(other,p===provider?otherGroup:wasm.Group.load(p,other));
    m._groupGenerations.set(cid,await storage.loadGroupState(cid)||{cid,group_generation:1,group_id:id,status:'active',current_epoch:0,updated_at:Date.now()});
    m._groupGenerations.set(other,{cid:other,group_generation:0,group_id:null,status:'active',current_epoch:0});
    for(const pending of await storage.listPendingMlsMutations())m._pendingMlsMutations.set(pending.cid,pending);
    m._collectPendingGhosts=async()=>[];m._cleanupEvictedGhosts=async()=>{};m.safeArchiveCurrentEpoch=async()=>{};
    return m;
  }
  await storage.saveIdentity(user,'device',identity.to_bytes());
  const m=await manager();await m._writeMlsMutation(cid,null);await m._writeMlsMutation(other,null);
  await m._prepareMlsMutation(cid,m._captureMlsPreparation(cid),(p,g)=>{
    const bundle=g.commit_self_update_with_removals(p,identity,[]);
    return {group:g,marker:{...m._groupGenerations.get(cid)},commit:bundle.commit,ghosts:[],expected_epoch:0,
      request:{kind:'rotation',channel_type:'team',channel_id:user,target_user_ids:[],body:{commit:bundle.commit,epoch:0}}};
  });
  const pending=m._pendingMlsMutations.get(cid),bytes=await storage.loadProviderState(user,'device');
  const restart=async()=>manager(wasm.Provider.from_bytes(await storage.loadProviderState(user,'device')));
  const durableEpoch=async()=>Number(wasm.Group.load_with_group_id(wasm.Provider.from_bytes(await storage.loadProviderState(user,'device')),id).epoch());
  return {m,storage,cid,user,id,pending,provider:m._activeProvider,identity,group:m.groups.get(cid),other,bytes,restart,durableEpoch};
}
async function editStore(storage,store,key,value){const db=await storage.openDB();await new Promise((r,j)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=r;tx.onabort=()=>j(tx.error);});}
function abortWrite(storage,phase){
  const write=storage._writeProviderCheckpoint.bind(storage);let n=0;
  storage._writeProviderCheckpoint=(tx,...args)=>{write(tx,...args);if(++n===phase)tx.abort();};
  return ()=>{storage._writeProviderCheckpoint=write;};
}
for(const phase of [1,2])test(`actual transaction abort at ${phase===1?'acceptance':'finalization'} preserves active state and restart settles once`,async()=>{
  const h=await fixture(),restore=abortWrite(h.storage,phase);
  await assert.rejects(h.m._finishMlsMutation(h.cid),e=>e.checkpoint_outcome==='aborted');
  assert.equal(h.m._activeProvider,h.provider);assert.equal(h.m.getEpoch(h.cid),0);assert.equal(h.m.groups.get(h.cid).has_pending_commit(),true);
  assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(await h.durableEpoch(),0);
  const [journal]=await h.storage.listPendingMlsMutations();assert.equal(journal.accepted,phase===2);assert.deepEqual(journal.commit,h.pending.commit);
  restore();const n=await h.restart();let sends=0;n.e2eeClient={keyRotation:async()=>{sends++;}};
  if(phase===1)await n._finishMlsMutation(h.cid);else await n._resumePendingMlsMutations();
  await n._finishMlsMutation(h.cid);assert.equal(n.getEpoch(h.cid),1);assert.equal(sends,0);assert.equal(await h.durableEpoch(),1);
  assert.deepEqual(await h.storage.listPendingMlsMutations(),[]);
});
test('actual unsent rejection abort and successful cancellation never restore a whole snapshot',async()=>{
  const h=await fixture(),restore=abortWrite(h.storage,1);
  await assert.rejects(h.m._rejectMlsMutation(h.cid,h.pending,'not_submitted'),e=>e.checkpoint_outcome==='aborted');
  assert.equal(h.m._activeProvider,h.provider);assert.equal(h.group.has_pending_commit(),true);assert.equal(await h.durableEpoch(),0);
  restore();await h.m._rejectMlsMutation(h.cid,h.pending,'not_submitted');
  assert.notEqual(h.m._activeProvider,h.provider);assert.equal(h.m.groups.get(h.cid).has_pending_commit(),false);
  assert.equal(h.m.getEpoch(h.other),0);assert.deepEqual(await h.storage.listPendingMlsMutations(),[]);
});
test('submitted uncertainty, arbitrary 409 and accepted journal cannot authorize local rejection',async()=>{
  const h=await fixture();await assert.rejects(h.m._rejectMlsMutation(h.cid),/mls_mutation_outcome_pending/);
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),h.bytes);
  h.pending.accepted=true;await assert.rejects(h.m._rejectMlsMutation(h.cid,h.pending,'not_submitted'),/mls_mutation_outcome_pending/);
});
for(const phase of [1,2])for(const failure of ['readback','metadata'])test(`committed ${phase===1?'acceptance':'finalization'} ${failure} failure keeps active unavailable and restart uses durable winner`,async()=>{
  const h=await fixture(),verify=h.storage.verifyMlsMutationCheckpoint.bind(h.storage);let n=0;
  h.storage.verifyMlsMutationCheckpoint=async cp=>{
    if(++n===phase){if(failure==='readback')throw new Error('readback failed');await editStore(h.storage,'groups',h.cid,{...cp.marker,updated_at:123});}
    return verify(cp);
  };
  await assert.rejects(h.m._finishMlsMutation(h.cid));assert.equal(h.m._activeProvider,h.provider);assert.equal(h.m.getEpoch(h.cid),0);
  assert.equal(h.m._providerPersistenceUncertain,true);assert.equal(await h.durableEpoch(),phase===2?1:0);
  assert.equal((await h.storage.listPendingMlsMutations()).length,phase===1?1:0);
  h.storage.verifyMlsMutationCheckpoint=verify;const nmanager=await h.restart();await nmanager._resumePendingMlsMutations();
  assert.equal(nmanager.getEpoch(h.cid),1);assert.deepEqual(await h.storage.listPendingMlsMutations(),[]);
});
test('adapter commits then throws: no stale provider import and restart finalizes accepted journal',async()=>{
  const h=await fixture(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage);
  h.storage.saveMlsMutationCheckpoint=async cp=>{await save(cp);throw new Error('unknown outcome');};
  await assert.rejects(h.m._finishMlsMutation(h.cid),/unknown outcome/);assert.equal(h.m._activeProvider,h.provider);
  assert.equal(h.m._providerPersistenceUncertain,true);assert.equal((await h.storage.listPendingMlsMutations())[0].accepted,true);
  h.storage.saveMlsMutationCheckpoint=save;const n=await h.restart();await n._resumePendingMlsMutations();assert.equal(n.getEpoch(h.cid),1);
});
test('intervening local private KeyPackage mutation is never overwritten by isolated settlement',async()=>{
  const h=await fixture(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage),entered=latch(),release=latch();
  h.storage.saveMlsMutationCheckpoint=async cp=>{entered.resolve();await release.promise;return save(cp);};
  const work=h.m._finishMlsMutation(h.cid);await entered.promise;
  const kp=h.identity.key_package(h.provider),ref=kp.hash_ref(h.provider);const winning=new Uint8Array(h.provider.to_bytes());
  release.resolve();await assert.rejects(work,/recovery_scope_changed/);
  assert.deepEqual(h.provider.to_bytes(),winning);assert.equal(h.m._activeProvider,h.provider);assert.equal(h.m.getEpoch(h.cid),0);
  assert.ok(ref);assert.equal(h.m._providerPersistenceUncertain,true);
});
test('remote provider CAS winner retains private packages, other group and cursor',async()=>{
  const h=await fixture(),checkpoint=await h.storage.loadProviderCheckpoint(h.user,'device');
  const winner=wasm.Provider.from_bytes(checkpoint.provider_bytes);new wasm.Identity(winner,'remote').key_package(winner);
  const winnerBytes=winner.to_bytes();await h.storage.saveProviderState(h.user,'device',winnerBytes,{expected_revision:checkpoint.revision,next_revision:'remote-winner'});
  await h.storage.saveScopeSyncCursor(h.other,{created_at:'2026-10-11T00:00:00Z',event_id:'73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2'});
  await assert.rejects(h.m._finishMlsMutation(h.cid),e=>e.code==='provider_checkpoint_conflict');
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),winnerBytes);assert.equal(h.m._activeProvider,h.provider);
  assert.equal((await h.storage.loadScopeSyncCursor(h.other)).event_id,'73cdd6ac-f83c-4fe4-8d3a-8e5b8d57dce2');assert.deepEqual(await h.storage.listPendingMlsMutations(),[h.pending]);
});
for(const path of ['groups','meta'])test(`remote ${path==='groups'?'marker':'pending'} replacement aborts before any overwrite`,async()=>{
  const h=await fixture(),key=path==='groups'?h.cid:'mls_mutation:v1:'+h.cid;
  const replacement=path==='groups'?{...h.m._groupGenerations.get(h.cid),group_generation:7}:{...h.pending,commit:new Uint8Array([99])};
  await editStore(h.storage,path,key,replacement);
  await assert.rejects(h.m._finishMlsMutation(h.cid),e=>e.code==='provider_checkpoint_conflict'&&e.checkpoint_outcome==='aborted');
  assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),h.bytes);
  assert.deepEqual(path==='groups'?await h.storage.loadGroupState(h.cid):(await h.storage.listPendingMlsMutations())[0],replacement);
});
for(const replacement of ['same-account','different-account','pending','group','marker','transport','artifact'])test(`delayed settlement cannot publish into ${replacement} replacement`,async()=>{
  const h=await fixture(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage),entered=latch(),release=latch();
  h.storage.saveMlsMutationCheckpoint=async cp=>{entered.resolve();await release.promise;return save(cp);};
  const work=h.m._finishMlsMutation(h.cid);await entered.promise;
  if(replacement==='same-account')h.m.storage=new IndexedDBEncryptionStorage(h.user);
  if(replacement==='different-account')h.m.userId='replacement-user';
  if(replacement==='pending')h.m._pendingMlsMutations.set(h.cid,structuredClone(h.pending));
  if(replacement==='marker')h.m._groupGenerations.set(h.cid,structuredClone(h.m._groupGenerations.get(h.cid)));
  if(replacement==='group')h.m.groups.set(h.cid,wasm.Group.load_with_group_id(h.provider,h.id));
  if(replacement==='transport')h.m.e2eeClient={};
  if(replacement==='artifact')h.m._wasmArtifactSha256='replacement';
  const active=h.m._activeProvider,group=h.m.groups.get(h.cid),pending=h.m._pendingMlsMutations.get(h.cid);
  release.resolve();await assert.rejects(work,/recovery_scope_changed/);
  assert.equal(h.m._activeProvider,active);assert.equal(h.m.groups.get(h.cid),group);assert.equal(h.m._pendingMlsMutations.get(h.cid),pending);
});
test('same owner shares settlement; old finally cannot delete a replacement promise',async()=>{
  const h=await fixture(),save=h.storage.saveMlsMutationCheckpoint.bind(h.storage),entered=latch(),release=latch();let writes=0;
  h.storage.saveMlsMutationCheckpoint=async cp=>{writes++;entered.resolve();await release.promise;return save(cp);};
  const first=h.m._finishMlsMutation(h.cid),second=h.m._finishMlsMutation(h.cid);await entered.promise;
  const replacement={owns:()=>false,assertCurrent:()=>{},work:Promise.resolve()};h.m._settlingMlsMutations.set(h.cid,replacement);
  release.resolve();await Promise.all([first,second]);assert.equal(writes,2);assert.equal(h.m.getEpoch(h.cid),1);
  assert.equal(h.m._settlingMlsMutations.get(h.cid),replacement);
});
test('queue admits next writer only after provider and all dependent handles switch',async()=>{
  const h=await fixture(),finish=h.m._finishMlsMutation(h.cid);await Promise.resolve();
  await h.m._withProviderMutation(async provider=>{assert.equal(provider,h.m._activeProvider);assert.notEqual(provider,h.provider);assert.equal(h.m.getEpoch(h.cid),1);assert.equal(h.m.getEpoch(h.other),0);});
  await finish;
});
test('legacy custom adapter without settlement capability fails before mutation',async()=>{
  const h=await fixture();h.storage.mlsMutationSettlementVersion=undefined;
  await assert.rejects(h.m._finishMlsMutation(h.cid),e=>e.code==='client_upgrade_required');
  assert.equal(h.m._activeProvider,h.provider);assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),h.bytes);
});
test('actual local restore preserves marker shape and accepted resume settles without HTTP',async()=>{
  const h=await fixture(),restore=abortWrite(h.storage,2);await assert.rejects(h.m._finishMlsMutation(h.cid));restore();
  const n=new EncryptionManager();Object.assign(n,{userId:h.user,deviceId:'device',storage:h.storage,_injectedWasm:wasm,_wasmArtifactSha256:h.m._wasmArtifactSha256});
  await n._initWasm();await n._initIdentity();await n._restoreGroupsLocally();await n._resumePendingMlsMutations();assert.equal(n.getEpoch(h.cid),1);
});
test('intervening verified private-package write survives successful settlement and reload',async()=>{
  const h=await fixture(),kp=h.identity.key_package(h.provider),ref=kp.hash_ref(h.provider);kp.free();
  await h.m._persistProviderStrict();await h.m._finishMlsMutation(h.cid);
  assert.equal(h.identity.owns_key_package_ref(h.m._activeProvider,ref),true);
  const n=await h.restart();assert.equal(h.identity.owns_key_package_ref(n._activeProvider,ref),true);assert.equal(n.getEpoch(h.other),0);
});
test('concurrent resume shares one exact HTTP and conditional cleanup retains replacement work',async()=>{
  const h=await fixture(),entered=latch(),release=latch(),channel={};let sends=0;
  h.m._getActiveChannel=()=>channel;h.m._getMembershipCreatedAt=()=> '2026-10-11T00:00:00Z';h.m._syncChannelFromCursor=async()=>{};
  h.m.e2eeClient={keyRotation:async(_t,_id,body)=>{sends++;assert.deepEqual(body.commit,h.pending.commit);entered.resolve();await release.promise;}};
  const a=h.m._resumePendingMlsMutations(),b=h.m._resumePendingMlsMutations();await entered.promise;
  const replacement={pending:{},assertCurrent:()=>{},work:Promise.resolve()};h.m._resumingMlsMutations.set(h.cid,replacement);
  release.resolve();await Promise.all([a,b]);assert.equal(sends,1);assert.equal(h.m.getEpoch(h.cid),1);assert.equal(h.m._resumingMlsMutations.get(h.cid),replacement);
});
for(const replacement of ['same-account','different-account','pending'])test(`delayed resume transport cannot settle ${replacement} replacement`,async()=>{
  const h=await fixture(),entered=latch(),release=latch(),channel={};
  h.m._getActiveChannel=()=>channel;h.m._getMembershipCreatedAt=()=> '2026-10-11T00:00:00Z';h.m._syncChannelFromCursor=async()=>{};
  h.m.e2eeClient={keyRotation:async()=>{entered.resolve();await release.promise;}};
  const work=h.m._resumePendingMlsMutations();await entered.promise;
  if(replacement==='same-account')h.m.storage=new IndexedDBEncryptionStorage(h.user);
  else if(replacement==='different-account')h.m.userId='replacement';
  else h.m._pendingMlsMutations.set(h.cid,structuredClone(h.pending));
  const pending=h.m._pendingMlsMutations.get(h.cid);release.resolve();await assert.rejects(work,/recovery_scope_changed/);
  assert.equal(h.m._pendingMlsMutations.get(h.cid),pending);assert.equal(h.m.getEpoch(h.cid),0);assert.deepEqual(await h.storage.loadProviderState(h.user,'device'),h.bytes);
});
