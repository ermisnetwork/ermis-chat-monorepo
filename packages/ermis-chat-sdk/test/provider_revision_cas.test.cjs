const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{webcrypto,randomUUID}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage}=require('../dist/encryption/index.cjs');
let sequence=0,wasmPromise;
const cursor=n=>({created_at:`2026-10-01T00:00:0${n}.000Z`,event_id:`00000000-0000-4000-8000-00000000000${n}`});
const conflict=e=>e.code==='provider_checkpoint_conflict';
const guard=revision=>({expected_revision:revision,next_revision:randomUUID()});
async function fixture(){
  const wasm=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));
    await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});return w;})());
  const user=`revision-${++sequence}`,device='same-browser-device',cid=`team:revision-${sequence}`;
  async function manager(userId=user,deviceId=device){const storage=new IndexedDBEncryptionStorage(userId),m=new EncryptionManager();
    Object.assign(m,{storage,userId,deviceId,_injectedWasm:wasm});await m._initWasm();await m._initIdentity();m.initialized=true;
    m.client={activeChannels:{},dispatchEvent:()=>{}};return m;}
  const a=await manager();await a._persistProviderStrict();const b=await manager();
  // Identity import is now a private checkpoint. Explicitly reload the first
  // provider after that checkpoint so both race participants start at its
  // same owned durable base; no unrelated read silently advances a guard.
  await a._restoreOrCreateProvider();
  return{wasm,user,device,cid,a,b,manager,close:async()=>{await a.storage.close();await b.storage.close();}};
}

test('two loaded managers reject stale provider/cursor writes and retain the winning private KeyPackage',async()=>{
  const f=await fixture(),old=await f.a.storage.loadProviderCheckpoint(f.user,f.device);
  const kp=f.a.identity.key_packages_typed(f.a.provider,1)[0],reference=kp.hash_ref(f.a.provider);kp.free();
  await f.a._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:cursor(2)}});
  const winner=await f.a.storage.loadProviderCheckpoint(f.user,f.device);assert.notEqual(winner.revision,old.revision);
  const restored=f.wasm.Provider.from_bytes(winner.provider_bytes);assert.equal(f.a.identity.owns_key_package_ref(restored,reference),true);restored.free();
  await assert.rejects(f.b._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:cursor(1)}}),conflict);
  assert.equal(f.b._providerPersistenceUncertain,true);assert.throws(()=>f.b.provider,e=>e.code==='provider_persistence_uncertain');
  assert.deepEqual(await f.a.storage.loadProviderCheckpoint(f.user,f.device),winner);
  assert.deepEqual(await f.a.storage.loadScopeSyncCursor(f.cid),cursor(2));await f.close();
});

test('equal-byte provider checkpoints still rotate revision and reject cursor ABA',async()=>{
  const f=await fixture(),s=f.a.storage,base=await s.loadProviderCheckpoint(f.user,f.device);
  const first={user_id:f.user,device_id:f.device,provider_bytes:base.provider_bytes,provider_write_guard:guard(base.revision),scope_cursors:{[f.cid]:cursor(2)}};
  await s.saveEncryptionSyncCheckpoint(first);assert.equal(await s.verifyEncryptionSyncCheckpoint(first),true);
  const second={...first,provider_write_guard:guard(first.provider_write_guard.next_revision),scope_cursors:{[f.cid]:cursor(3)}};
  await f.b.storage.saveEncryptionSyncCheckpoint(second);
  await assert.rejects(s.saveEncryptionSyncCheckpoint({...first,provider_write_guard:guard(base.revision),scope_cursors:{[f.cid]:cursor(1)}}),conflict);
  assert.equal(await s.verifyEncryptionSyncCheckpoint(first),false);
  assert.deepEqual(await s.loadScopeSyncCursor(f.cid),cursor(3));await f.close();
});

test('all seven default provider writers abort stale provider and accompanying metadata atomically',async()=>{
  for(const writer of ['provider','upload','join','mutation','external','rebootstrap','sync']){
    const f=await fixture(),s=f.b.storage,base=await s.loadProviderCheckpoint(f.user,f.device),g=guard(base.revision);
    await f.a._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:cursor(2)}});
    const winner=await s.loadProviderCheckpoint(f.user,f.device),c={user_id:f.user,device_id:f.device,cid:f.cid,
      provider_bytes:Uint8Array.of(99),provider_write_guard:g,readiness:null,generation:{cid:f.cid,current_epoch:1}};
    const job={user_id:f.user,device_id:f.device,cid:f.cid,body:{operation_id:randomUUID()}};
    if(writer==='external')await s.saveExternalJoinCandidateCheckpoint(job);
    const invoke={provider:()=>s.saveProviderState(f.user,f.device,c.provider_bytes,g),
      upload:()=>s.saveKeyPackageUploadCheckpoint(f.user,f.device,c.provider_bytes,{operation_id:'stale'},g),
      join:()=>s.saveJoinCheckpoint(c),mutation:()=>s.saveMlsMutationCheckpoint({...c,marker:true,pending:{cid:f.cid}}),
      external:()=>s.saveExternalJoinActivationCheckpoint(c,{operation_id:job.body.operation_id,cid:f.cid,state:'accepted'},base.provider_bytes),
      rebootstrap:()=>s.saveRebootstrapCandidateCheckpoint({...c,marker:{cid:f.cid}}),
      sync:()=>s.saveEncryptionSyncCheckpoint({...c,scope_cursors:{[f.cid]:cursor(1)},pending_snapshots:{[f.cid]:[{message_id:'stale'}]},repair_states:[{scope_cid:f.cid,status:'stale'}]})};
    await assert.rejects(invoke[writer](),conflict);
    assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),winner);assert.equal(await s.loadGroupState(f.cid),null);
    assert.deepEqual(await s.loadScopeSyncCursor(f.cid),cursor(2));assert.equal(await s.loadPendingKeyPackageUpload(f.user,f.device),null);
    assert.equal(await s.loadRebootstrapCandidateCheckpoint(f.cid),null);assert.deepEqual(await s.listPendingMlsMutations(),[]);
    assert.equal(await s.loadExternalJoinReadiness(f.cid),null);assert.deepEqual(await s.loadPendingE2eeSnapshots(f.cid),[]);
    if(writer==='external')assert.deepEqual(await s.loadExternalJoinCandidateCheckpoint(f.cid),job);
    await f.close();
  }
});

test('actual concurrent transactions have exactly one winner from the same loaded base',async()=>{
  const f=await fixture(),base=await f.a.storage.loadProviderCheckpoint(f.user,f.device);
  const outcomes=await Promise.allSettled([f.a,f.b].map((m,i)=>m.storage.saveEncryptionSyncCheckpoint({user_id:f.user,device_id:f.device,
    provider_bytes:base.provider_bytes,provider_write_guard:guard(base.revision),scope_cursors:{[f.cid]:cursor(i+1)}})));
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);const lost=outcomes.find(o=>o.status==='rejected');assert.equal(lost.reason.code,'provider_checkpoint_conflict');
  const index=outcomes.findIndex(o=>o.status==='fulfilled');assert.deepEqual(await f.a.storage.loadScopeSyncCursor(f.cid),cursor(index+1));await f.close();
});

test('snapshot/ACK reads cannot adopt another writer revision; restart explicitly loads its winning base',async()=>{
  const f=await fixture();await f.a._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:cursor(2)}});
  await f.b.storage.loadProviderCheckpoint(f.user,f.device);await f.b.storage.loadProviderState(f.user,f.device);
  await assert.rejects(f.b._persistProviderStrict(),conflict);
  const restarted=await f.manager();await restarted._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:cursor(3)}});
  assert.equal(restarted._providerPersistenceUncertain,false);assert.deepEqual(await restarted.storage.loadScopeSyncCursor(f.cid),cursor(3));await restarted.storage.close();await f.close();
});

test('null-revision legacy row upgrades lazily with CAS; concurrent first writer and corrupt revision fail closed',async()=>{
  const f=await fixture(),s=new IndexedDBEncryptionStorage(`${f.user}-legacy`),db=await s.openDB(),provider=f.a.provider.to_bytes();
  const write=async values=>new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');for(const [k,v]of values)tx.objectStore('meta').put(v,k);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  await write([[`provider:legacy:device`,provider]]);const before=await s.loadProviderCheckpoint('legacy','device');assert.equal(before.revision,null);
  const g=guard(null);await s.saveProviderState('legacy','device',provider,g);assert.equal((await s.loadProviderCheckpoint('legacy','device')).revision,g.next_revision);
  await assert.rejects(s.saveProviderState('legacy','device',provider,guard(null)),conflict);
  await write([[`provider_revision:legacy:device`,{broken:true}]]);
  await assert.rejects(s.loadProviderCheckpoint('legacy','device'),e=>e.code==='provider_checkpoint_invalid');
  await assert.rejects(s.saveProviderState('legacy','device',Uint8Array.of(99),guard(null)),e=>e.code==='provider_checkpoint_invalid');
  assert.deepEqual(await s.loadProviderState('legacy','device'),provider);await s.close();await f.close();
});

test('clone failure and real transaction abort preserve revision with provider and metadata',async()=>{
  for(const failure of ['clone','abort']){const f=await fixture(),s=f.a.storage,base=await s.loadProviderCheckpoint(f.user,f.device),db=await s.openDB();
    const c={user_id:f.user,device_id:f.device,provider_bytes:base.provider_bytes,provider_write_guard:guard(base.revision),scope_cursors:{[f.cid]:cursor(2)}};
    let original;if(failure==='clone')c.pending_snapshots={[f.cid]:[()=>{}]};else{original=db.transaction.bind(db);db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};}
    await assert.rejects(s.saveEncryptionSyncCheckpoint(c));if(original)db.transaction=original;
    assert.deepEqual(await s.loadProviderCheckpoint(f.user,f.device),base);assert.equal(await s.loadScopeSyncCursor(f.cid),null);await f.close();}
});

test('legacy default-adapter writes invalidate coordinated manager base; different accounts/devices have independent provider revisions',async()=>{
  const f=await fixture(),base=await f.a.storage.loadProviderCheckpoint(f.user,f.device);
  await f.b.storage.saveProviderState(f.user,f.device,base.provider_bytes);await assert.rejects(f.a._persistProviderStrict(),conflict);
  const otherDevice=await f.manager(f.user,'other-device'),otherUser=await f.manager(`${f.user}-other`);
  await otherDevice._persistProviderStrict();await otherUser._persistProviderStrict();
  assert.equal(otherDevice._providerPersistenceUncertain,false);assert.equal(otherUser._providerPersistenceUncertain,false);
  await otherDevice.storage.close();await otherUser.storage.close();await f.close();
});

test('stale sync cannot emit Ready or start another page after HTTP; winning cursor/private state remain intact',async()=>{
  const f=await fixture(),events=[];f.b.client={activeChannels:{},dispatchEvent:e=>events.push(e)};let calls=0;
  f.b.e2eeClient={scopeSync:async()=>{calls++;await f.a._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:cursor(3)}});
    return{channels:{[f.cid]:{events:[],next_cursor:cursor(1),has_more:true}}};}};
  await assert.rejects(f.b._syncChannelFromCursor(f.cid,cursor(1)),conflict);
  assert.equal(calls,1);assert.equal(events.filter(e=>e.type==='e2ee.sync_state'&&e.status==='ready').length,0);
  assert.deepEqual(await f.a.storage.loadScopeSyncCursor(f.cid),cursor(3));await f.close();
});

test('stale Welcome and KP candidates preserve active provider and send no upload before CAS',async()=>{
  for(const kind of ['welcome','upload']){
    const f=await fixture();let posts=0,work,ref;
    if(kind==='welcome'){
      const kp=f.b.identity.key_package_typed(f.b.provider);ref=kp.hash_ref(f.b.provider);await f.b._persistProviderStrict();
      const aliceProvider=new f.wasm.Provider(),alice=new f.wasm.Identity(aliceProvider,'alice'),g=f.wasm.Group.create_with_cid(aliceProvider,alice,f.cid);
      const bundle=g.add_members(aliceProvider,alice,[kp]);g.merge_pending_commit(aliceProvider);
      work=()=>f.b.joinGroup(bundle.welcome,g.export_ratchet_tree().to_bytes());
    }else{
      f.b.e2eeClient={uploadKeyPackages:async()=>{posts++;return{uploaded:1};}};
      work=()=>f.b._uploadKeyPackages(1);
    }
    const winnerManager=await f.manager();await winnerManager._persistProviderStrict();const winner=await f.a.storage.loadProviderCheckpoint(f.user,f.device);
    const active=f.b._activeProvider,before=active.to_bytes();await assert.rejects(work(),kind==='welcome'?e=>e.code==='recovery_checkpoint_conflict':conflict);
    assert.equal(f.b._activeProvider,active);assert.deepEqual(active.to_bytes(),before);assert.equal(f.b.groups.has(f.cid),false);
    assert.equal(posts,0);assert.equal(f.b._providerPersistenceUncertain,true);assert.deepEqual(await f.a.storage.loadProviderCheckpoint(f.user,f.device),winner);
    if(ref){const durable=f.wasm.Provider.from_bytes(winner.provider_bytes);assert.equal(f.b.identity.owns_key_package_ref(durable,ref),true);durable.free();}
    await winnerManager.storage.close();await f.close();
  }
});

test('committed MLS mutation readback failure blocks the ratchet and retains its durable pending journal',async()=>{
  const f=await fixture(),group=f.wasm.Group.create_with_cid(f.a.provider,f.a.identity,f.cid);f.a.groups.set(f.cid,group);await f.a._persistProviderStrict();
  f.a.storage.verifyMlsMutationCheckpoint=async()=>{throw Error('readback unavailable');};
  const pending={cid:f.cid,expected_epoch:0,group_generation:0,group_id:null,commit:Uint8Array.of(1),ghost_user_ids:[],accepted:false,
    request:{kind:'rotation',channel_type:'team',channel_id:f.cid.slice(5),target_user_ids:[],body:{}}};
  await assert.rejects(f.a._writeMlsMutation(f.cid,pending),/readback unavailable/);
  assert.equal(f.a._providerPersistenceUncertain,true);assert.throws(()=>f.a.provider,e=>e.code==='provider_persistence_uncertain');
  assert.deepEqual(await f.b.storage.listPendingMlsMutations(),[pending]);await f.close();
});

test('public coordinator cannot invent a CAS base or publish readiness after a stale guard',async()=>{
  const {PartialWelcomeJoinCoordinator}=require('../dist/encryption/index.cjs'),f=await fixture(),coordinator=new PartialWelcomeJoinCoordinator(f.b.storage);
  const loaded=await f.b.storage.loadProviderCheckpoint(f.user,f.device);
  await assert.rejects(coordinator.persistExternalJoin(f.cid,1,f.user,f.device,loaded.provider_bytes),e=>e.code==='client_upgrade_required');
  await f.a._persistProviderStrict();
  await assert.rejects(coordinator.persistExternalJoin(f.cid,1,f.user,f.device,loaded.provider_bytes,undefined,guard(loaded.revision)),conflict);
  assert.equal(await f.b.storage.loadExternalJoinReadiness(f.cid),null);await f.close();
});
