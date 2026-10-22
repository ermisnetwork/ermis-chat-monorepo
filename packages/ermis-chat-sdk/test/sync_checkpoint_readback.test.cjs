const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{webcrypto}=require('node:crypto');
require('fake-indexeddb/auto');globalThis.crypto??=webcrypto;
const {EncryptionManager,IndexedDBEncryptionStorage}=require('../dist/encryption/index.cjs');
let sequence=0,wasmPromise;
const since={created_at:'2026-10-01T00:00:00.000Z',event_id:'00000000-0000-4000-8000-000000000001'};
const next={created_at:'2026-10-01T00:00:01.000Z',event_id:'00000000-0000-4000-8000-000000000002'};
function latch(){let open;const promise=new Promise(r=>open=r);return{promise,open};}
async function fixture(){
  const wasm=await(wasmPromise??=(async()=>{const w=await import(pathToFileURL(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm.js')));
    await w.default({module_or_path:fs.readFileSync(path.resolve(__dirname,'../src/encryption/wasm/openmls_wasm_bg.wasm'))});return w;})());
  const user=`sync-proof-${++sequence}`,device='sync-device',cid=`team:sync-${sequence}`,storage=new IndexedDBEncryptionStorage(user),events=[];
  const m=new EncryptionManager();Object.assign(m,{storage,userId:user,deviceId:device,_injectedWasm:wasm});
  await m._initWasm();await m._initIdentity();await m._persistProviderStrict();m.initialized=true;
  const group=wasm.Group.create_with_cid(m.provider,m.identity,cid);m.groups.set(cid,group);await m._persistProviderStrict();
  m.client={activeChannels:{},dispatchEvent:e=>events.push(e)};
  const checkpoint=()=>({user_id:user,device_id:device,provider_bytes:new Uint8Array(m._activeProvider.to_bytes()),
    scope_cursors:{[cid]:next},pending_snapshots:{[cid]:[{cid,event_type:'application',message_id:'public-fixture',version:'v1',
      message:{id:'public-fixture',mls_ciphertext:Uint8Array.of(1,2),created_at:new Date(since.created_at)}}]},
    repair_states:[{scope_cid:cid,status:'replaying',fail_count:1,last_safe_cursor:since,updated_at:1}]});
  const options=()=>{const c=checkpoint();return{scopeCursors:c.scope_cursors,pendingSnapshots:c.pending_snapshots,repairStates:c.repair_states};};
  const emitted=()=>events.filter(e=>e.type==='e2ee.sync_state');
  return{m,storage,user,device,cid,events,checkpoint,options,emitted};
}
function transport(f,{empty=false}={}){
  f.m.e2eeClient={scopeSync:async()=>({channels:{[f.cid]:{events:empty?[]:[{type:'fixture',created_at:next.created_at,id:next.event_id}],next_cursor:next,has_more:false}}})};
  f.m._processChannelEvents=async()=>({processedEventCursor:next,processedEvents:1,bufferedMessages:0,decrypted:[]});
  f.m._flushPendingSnapshotsForScope=async()=>({decrypted:[],pending:[]});
}
function globalSync(f){
  f.m._restoreGroupsLocally=async()=>{};f.m._loadAllScopeSyncCursors=async()=>({[f.cid]:since});
  f.m._listKnownE2eeChannels=()=>[{cid:f.cid}];f.m._membershipBoundedEventCursor=(_c,saved)=>saved;
  f.m._discoverMlsRecoveryStates=async()=>({states:{},unsupported:false});f.m.bootstrapKnownE2eeChannels=async()=>{};
  f.m._replayLaggingEpochs=async()=>{};f.m._resumeExternalJoinCandidates=async()=>{};f.m._resumePendingMlsMutations=async()=>{};
}

test('atomic IndexedDB readback verifies exact provider/cursors/binary pending/repair plus deleted empty queues across restart',async()=>{
  const f=await fixture(),c=f.checkpoint();c.pending_snapshots['team:empty']=[];c.scope_cursors['team:other']={...since};
  await f.storage.savePendingE2eeSnapshots('team:empty',[{cid:'team:empty',message_id:'old',event_type:'application',message:{},version:'old'}]);
  await f.storage.saveEncryptionSyncCheckpoint(c);assert.equal(await f.storage.verifyEncryptionSyncCheckpoint(c),true);
  assert.deepEqual(await f.storage.loadPendingE2eeSnapshots('team:empty'),[]);
  await f.storage.close();const restarted=new IndexedDBEncryptionStorage(f.user);assert.equal(await restarted.verifyEncryptionSyncCheckpoint(c),true);
  const wrong=structuredClone(c);wrong.pending_snapshots[f.cid][0].message.mls_ciphertext[0]^=1;
  assert.equal(await restarted.verifyEncryptionSyncCheckpoint(wrong),false);assert.equal(await restarted.verifyEncryptionSyncCheckpoint({...c,device_id:'other-device'}),false);
  await restarted.close();
});

test('corrupted provider/cursor/pending/repair readback poisons only the current ratchet and invalidates old Ready without rollback',async()=>{
  for(const field of ['provider','cursor','pending','repair']){
    const f=await fixture(),save=f.storage.saveEncryptionSyncCheckpoint.bind(f.storage),provider=f.m._activeProvider;
    f.m._emitSyncState(f.m._makeSyncState(f.cid,'ready',since,since));f.events.length=0;
    f.storage.saveEncryptionSyncCheckpoint=async c=>{await save(c);
      if(field==='provider')await f.storage.saveProviderState(f.user,f.device,Uint8Array.of(99));
      if(field==='cursor')await f.storage.saveScopeSyncCursor(f.cid,since);
      if(field==='pending')await f.storage.savePendingE2eeSnapshots(f.cid,[]);
      if(field==='repair')await f.storage.saveChannelRepairState({...c.repair_states[0],fail_count:2});};
    await assert.rejects(f.m._saveEncryptionSyncCheckpoint(f.options()),e=>e.code==='provider_persistence_uncertain');
    assert.equal(f.m._activeProvider,provider);assert.equal(f.m.groups.has(f.cid),true);assert.equal(f.m._providerPersistenceUncertain,true);
    assert.equal(f.m.getSyncState(f.cid).status,'needs_retry');assert.equal(f.emitted().length,0);
    assert.throws(()=>f.m.provider,e=>e.code==='provider_persistence_uncertain');await f.storage.close();
  }
});

test('real IndexedDB save and verification transaction aborts reject before publication and preserve the last committed tuple',async()=>{
  for(const phase of ['save','verify']){
    const f=await fixture();await f.storage.saveScopeSyncCursor(f.cid,since);const old=await f.storage.loadProviderState(f.user,f.device);
    const db=await f.storage.openDB(),original=db.transaction.bind(db);
    db.transaction=(...args)=>{const tx=original(...args);if(args[1]===(phase==='save'?'readwrite':'readonly'))queueMicrotask(()=>tx.abort());return tx;};
    await assert.rejects(f.m._saveEncryptionSyncCheckpoint(f.options()),e=>e instanceof Error && (e.name==='AbortError' || /Sync checkpoint.*aborted/.test(e.message)));db.transaction=original;
    assert.equal(f.m._providerPersistenceUncertain,true);assert.equal(f.emitted().length,0);
    assert.deepEqual(await f.storage.loadProviderState(f.user,f.device),old);
    assert.deepEqual(await f.storage.loadScopeSyncCursor(f.cid),phase==='save'?since:next);await f.storage.close();
  }
});

test('custom metadata adapters need atomic save and verification before any provider/cursor write; provider-only legacy path reads exact bytes',async()=>{
  for(const missing of ['save','verify']){
    const f=await fixture();let writes=0;f.storage.saveProviderState=async()=>{writes++;};
    if(missing==='save')f.storage.saveEncryptionSyncCheckpoint=undefined;else f.storage.verifyEncryptionSyncCheckpoint=undefined;
    await assert.rejects(f.m._saveEncryptionSyncCheckpoint({scopeCursors:{[f.cid]:next}}),e=>e.code==='client_upgrade_required');
    assert.equal(writes,0);assert.deepEqual(await f.storage.loadScopeSyncCursor(f.cid),null);await f.storage.close();
  }
  const f=await fixture();f.storage.saveEncryptionSyncCheckpoint=undefined;f.storage.verifyEncryptionSyncCheckpoint=undefined;
  f.storage.providerCheckpointCASVersion=undefined;f.storage.loadProviderCheckpoint=undefined;
  await f.m._saveEncryptionSyncCheckpoint();assert.equal(f.m._providerPersistenceUncertain,false);
  f.storage.loadProviderState=async()=>null;await assert.rejects(f.m._saveEncryptionSyncCheckpoint(),e=>e.code==='provider_persistence_uncertain');await f.storage.close();
});

test('single-channel sync including empty and held-prefix pages cannot publish until atomic readback completes',async()=>{
  for(const mode of ['events','empty','held']){
    const f=await fixture();transport(f,{empty:mode==='empty'});
    if(mode==='held')f.m._processChannelEvents=async()=>({processedEventCursor:since,processedEvents:0,bufferedMessages:1,decrypted:[]});
    const entered=latch(),release=latch(),verify=f.storage.verifyEncryptionSyncCheckpoint.bind(f.storage);
    f.storage.verifyEncryptionSyncCheckpoint=async c=>{entered.open();await release.promise;return verify(c);};
    const work=f.m._syncChannelFromCursor(f.cid,since);await entered.promise;assert.equal(f.emitted().length,0);
    assert.throws(()=>f.m.provider,e=>e.code==='provider_mutation_busy');release.open();const result=await work;
    assert.equal(f.emitted().length,1);assert.equal(result.status,mode==='held'?'needs_retry':'ready');
    assert.deepEqual(await f.storage.loadScopeSyncCursor(f.cid),mode==='events'?next:since);await f.storage.close();
  }
});

test('global sync buffers its final callbacks until aggregate readback; readback failure rejects sync instead of reporting success',async()=>{
  for(const failed of [false,true]){
    const f=await fixture();transport(f);globalSync(f);const entered=latch(),release=latch(),verify=f.storage.verifyEncryptionSyncCheckpoint.bind(f.storage);
    f.storage.verifyEncryptionSyncCheckpoint=async c=>{entered.open();await release.promise;return failed?false:verify(c);};
    const work=f.m.sync(),rejected=failed?assert.rejects(work,e=>e.code==='provider_persistence_uncertain'):null;
    await entered.promise;assert.equal(f.emitted().length,0);release.open();if(failed)await rejected;else await work;
    assert.equal(f.emitted().length,failed?0:1);assert.equal(f.m.isSyncing(),false);assert.equal(f.m._providerPersistenceUncertain,failed);await f.storage.close();
  }
});

test('failed single-channel readback leaves no early Ready callback even after the cursor transaction committed',async()=>{
  for(const empty of [false,true]){
    const f=await fixture();transport(f,{empty});f.storage.verifyEncryptionSyncCheckpoint=async()=>false;
    await assert.rejects(f.m._syncChannelFromCursor(f.cid,since),e=>e.code==='provider_persistence_uncertain');
    assert.equal(f.emitted().length,0);assert.equal(f.m.getSyncState(f.cid),null);assert.equal(f.m.groups.has(f.cid),true);await f.storage.close();
  }
});

test('old sync HTTP response under replaced account/client/storage never processes, checkpoints or publishes into the new scope',async()=>{
  for(const global of [false,true])for(const replacement of ['user','client','storage']){
    const f=await fixture();transport(f);if(global)globalSync(f);let processed=0,written=0;const entered=latch(),release=latch(),old=f.m.e2eeClient;
    f.m._processChannelEvents=async()=>{processed++;assert.fail('stale scope processed');};
    f.storage.saveEncryptionSyncCheckpoint=async()=>{written++;assert.fail('stale scope saved');};
    f.m.e2eeClient={scopeSync:async()=>{entered.open();await release.promise;return old.scopeSync();}};
    const work=global?f.m._syncAndRestoreGroups():f.m._syncChannelFromCursor(f.cid,since),rejected=assert.rejects(work,e=>e.code==='recovery_scope_changed');
    await entered.promise;if(replacement==='user')f.m.userId='new-account';if(replacement==='client')f.m.client={dispatchEvent:()=>assert.fail('new-client callback')};
    if(replacement==='storage')f.m.storage={};release.open();await rejected;assert.equal(processed,0);assert.equal(written,0);assert.equal(f.emitted().length,0);await f.storage.close();
  }
});

test('late failed checkpoint verification cannot poison a replacement signer/storage/account scope',async()=>{
  for(const replacement of ['user','storage','identity']){
    const f=await fixture(),entered=latch(),release=latch();f.storage.verifyEncryptionSyncCheckpoint=async()=>{entered.open();await release.promise;throw Error('old readback failed');};
    const work=f.m._saveEncryptionSyncCheckpoint(f.options()),rejected=assert.rejects(work);await entered.promise;
    if(replacement==='user')f.m.userId='new-account';if(replacement==='storage')f.m.storage={};if(replacement==='identity')f.m.identity={};
    release.open();await rejected;assert.equal(f.m._providerPersistenceUncertain,false);assert.equal(f.m._providerMutationQueued,0);await f.storage.close();
  }
});

test('submitted tuple is frozen before provider queue wait and adapter mutation cannot rewrite its verification expectation',async()=>{
  const f=await fixture(),entered=latch(),release=latch();const prior=f.m._withProviderMutation(async()=>{entered.open();await release.promise;});await entered.promise;
  const options=f.options(),work=f.m._saveEncryptionSyncCheckpoint(options);options.scopeCursors[f.cid]=since;options.pendingSnapshots[f.cid]=[];
  release.open();await prior;await work;assert.deepEqual(await f.storage.loadScopeSyncCursor(f.cid),next);
  const save=f.storage.saveEncryptionSyncCheckpoint.bind(f.storage);f.storage.saveEncryptionSyncCheckpoint=async c=>{c.scope_cursors[f.cid]=since;await save(c);};
  await assert.rejects(f.m._saveEncryptionSyncCheckpoint(f.options()),e=>e.code==='provider_persistence_uncertain');await f.storage.close();
});


test('synchronous listener scope replacement cannot receive later CID callbacks or start another sync page/continuation',async()=>{
  for(const global of [false,true])for(const replacement of ['user','client']){
    const f=await fixture();transport(f);if(global)globalSync(f);let requests=0,discovery=0;const newEvents=[],old=f.m.e2eeClient;
    if(global){
      const second=`${f.cid}-second`;f.m.groups.set(second,f.m._injectedWasm.Group.create_with_cid(f.m.provider,f.m.identity,second));
      f.m.e2eeClient={scopeSync:async()=>{requests++;const response=await old.scopeSync();response.channels[second]={events:[],has_more:false};return response;}};
      f.m._discoverMlsRecoveryStates=async()=>{discovery++;assert.fail('old sync continued after listener switch');};
    }else f.m.e2eeClient={scopeSync:async()=>{requests++;const response=await old.scopeSync();response.channels[f.cid].has_more=true;return response;}};
    f.m.client.dispatchEvent=e=>{f.events.push(e);if(e.type!=='e2ee.sync_state')return;
      if(replacement==='user')f.m.userId='listener-account';else f.m.client={dispatchEvent:event=>newEvents.push(event)};};
    await assert.rejects(global?f.m._syncAndRestoreGroups():f.m._syncChannelFromCursor(f.cid,since),e=>e.code==='recovery_scope_changed');
    assert.equal(requests,1);assert.equal(discovery,0);assert.equal(f.emitted().length,1);assert.deepEqual(newEvents,[]);await f.storage.close();
  }
});
