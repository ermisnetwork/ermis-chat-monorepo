const test=require('node:test');
const assert=require('node:assert/strict');
const {EncryptionManager}=require('../dist/encryption/index.cjs');
function fixture(){
  const m=new EncryptionManager();m.userId='user';m.deviceId='device';m.identity={};
  let durable=Uint8Array.of(1);m.provider={to_bytes:()=>Uint8Array.of(2)};
  m.storage={saveProviderState:async(_u,_d,bytes)=>{durable=new Uint8Array(bytes);},loadProviderState:async()=>new Uint8Array(durable)};
  return m;
}
test('checkpoint queue caps32 tasks, typed overload does not run work, FIFO releases after errors',async()=>{
  const m=fixture();let release,entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r),order=[];
  const first=m._withProviderMutation(async()=>{entered();await gate;order.push(0);});await start;
  const jobs=Array.from({length:31},(_,i)=>m._withProviderMutation(async()=>{order.push(i+1);if(i===12)throw Error('one failed task');}));
  const settled=Promise.allSettled(jobs);
  await assert.rejects(m._withProviderMutation(async()=>assert.fail('overload work ran')),e=>e.code==='provider_mutation_busy');
  assert.equal(m._providerMutationQueued,32);release();await first;
  const outcomes=await settled;assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.deepEqual(order,Array.from({length:32},(_,i)=>i));assert.equal(m._providerMutationQueued,0);
  await m._withProviderMutation(async()=>{});assert.equal(m._providerMutationQueued,0);
});
test('strict provider checkpoint requires exact durable bytes; save failure or lost readback blocks active ratchet',async()=>{
  for(const mode of ['save','missing','corrupt','read']){
    const m=fixture();
    if(mode==='save')m.storage.saveProviderState=async()=>{throw Error('quota');};
    if(mode==='missing')m.storage.loadProviderState=async()=>null;
    if(mode==='corrupt')m.storage.loadProviderState=async()=>Uint8Array.of(99);
    if(mode==='read')m.storage.loadProviderState=async()=>{throw Error('readback lost');};
    await assert.rejects(m._persistProviderStrict());assert.equal(m._providerPersistenceUncertain,true);
    assert.throws(()=>m.provider,e=>e.code==='provider_persistence_uncertain');
    await assert.rejects(m._withProviderMutation(async()=>assert.fail('uncertain ratchet used')));
    assert.equal(m._providerMutationQueued,0);
  }
});
test('successful strict checkpoint awaits readback; late old-scope failure cannot poison a replacement adapter',async()=>{
  const m=fixture();await m._persistProviderStrict();assert.equal(m._providerPersistenceUncertain,false);
  let release,entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const original=m.storage;m.storage.saveProviderState=async()=>{entered();await gate;throw Error('old adapter failed');};
  const saving=m._persistProviderStrict();const failure=assert.rejects(saving);await start;
  m.storage={...original};release();await failure;
  assert.equal(m._providerPersistenceUncertain,false);assert.equal(m._providerMutationQueued,0);
});

test('legacy sync callback cannot fabricate Ready; failed durability keeps usable-state blocked',async()=>{
  const m=fixture(),cid='team:durability',events=[];
  m.client={dispatchEvent:event=>events.push(event)};m.groups.set(cid,{});
  const cursor={created_at:new Date().toISOString(),event_id:'00000000-0000-4000-8000-000000000001'};
  m._emitSyncState(m._makeSyncState(cid,'ready',cursor,cursor));assert.equal(m.getSyncState(cid).status,'needs_retry');assert.equal(m.getSyncState(cid).error,'local_checkpoint_pending');
  m.storage.saveProviderState=async()=>{throw Error('quota');};await assert.rejects(m._persistProviderStrict());
  assert.equal(m.getSyncState(cid).status,'needs_retry');assert.equal(await m._isScopeReadyForOpen(cid,cursor),false);
  m._emitSyncState(m._makeSyncState(cid,'ready',cursor,cursor));assert.equal(events.at(-1).sync_state.error,'provider_persistence_uncertain');
  m._emitGroupInfoRepairState({cid,status:'ready',reason:'group_info_available'});
  assert.equal(events.at(-1).repair_status,'retryable');assert.equal(events.at(-1).reason,'local_checkpoint_pending');
});

test('late failure under a replaced signer cannot poison the new identity scope',async()=>{
  const m=fixture();let release,entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  m.storage.saveProviderState=async()=>{entered();await gate;};
  const saving=m._persistProviderStrict(),failure=assert.rejects(saving);await start;m.identity={};release();await failure;
  assert.equal(m._providerPersistenceUncertain,false);assert.equal(m._providerMutationQueued,0);
});
