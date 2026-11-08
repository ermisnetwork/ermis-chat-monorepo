import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import init,* as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {ErmisChat,EncryptionManager,IndexedDBEncryptionStorage,sha256Hex}=createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
const wasmBytes=fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm',import.meta.url));
await init({module_or_path:wasmBytes});let seq=0;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function fixture(){
 const user='common-'+(++seq),device='device',cid='team:'+user,s=new IndexedDBEncryptionStorage(user),events=[];
 const m=new EncryptionManager();Object.assign(m,{userId:user,deviceId:device,storage:s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(wasmBytes)});await m._initWasm();await m._initIdentity();
 const group=wasm.Group.create_with_cid(m.provider,m.identity,cid),marker={cid,group_generation:0,group_id:null,current_epoch:0,status:'active',updated_at:1};m.groups.set(cid,group);m._groupGenerations.set(cid,marker);await m._writeMlsMutation(cid,null);
 const channel={data:{mls_enabled:true},state:{members:{[user]:{user_id:user,created_at:'2026-10-11T00:00:00Z'}}}};
 m.client={activeChannels:{[cid]:channel},dispatchEvent:e=>events.push(e)};m.e2eeClient={};m.initialized=true;
 const kp=m.identity.key_package(m.provider),ref=kp.hash_ref(m.provider);kp.free();await m._saveEncryptionSyncCheckpoint();
 return{m,s,user,device,cid,group,marker,channel,events,ref,bytes:m.provider.to_bytes(),base:await s.loadProviderCheckpoint(user,device)};
}
const control=(h,revision='1',action='repair')=>({version:1,user_id:h.user,device_id:h.device,cid:h.cid,signing_identity_sha256:sha256Hex(h.m.identity.signature_public_key()),group_generation:0,incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:action,recovery_revision:revision,repair_retry_until:'2026-10-12T23:59:59Z'});
test('Welcome recovery without a repair gate rechecks real Ready instead of leaving an orphaned deferred-sync barrier',async()=>{
 const h=await fixture(),done=latch();let calls=0,observed;
 try{
  assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
  h.m.ensureChannelReady=async(type,id,cid)=>{
   assert.equal(type,'team');assert.equal(cid,h.cid);assert.equal(id,h.cid.slice(5));calls++;
   observed=await h.m.refreshE2eeState(cid);done.resolve();return {cid,status:observed.state};
  };
  h.m.requestScopeSyncAfterRepair(h.cid);
  assert.equal(h.m._scopeSyncRequestedAfterRepair.has(h.cid),false,'there is no repair completion that could drain this flag');
  await done.promise;
  assert.equal(calls,1);assert.equal(observed.state,'ready');
  assert.deepEqual(h.m.provider.to_bytes(),h.bytes);
  assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);
 }finally{h.m.destroy();await h.s.close();}
});
test('Welcome recovery during an actual repair gate remains deferred until normal gate completion',async()=>{
 const h=await fixture(),done=latch();let admissions=0,syncs=0,observed;
 try{
  h.m.ensureChannelReady=async()=>{admissions++;assert.fail('must wait for active repair');};
  h.m._syncChannelFromCursor=async(cid)=>{syncs++;observed=await h.m.refreshE2eeState(cid);done.resolve();};
  h.m._startScopeRepairGate(h.cid);h.m.requestScopeSyncAfterRepair(h.cid);
  assert.equal(h.m._scopeSyncRequestedAfterRepair.has(h.cid),true);assert.equal(admissions,0);assert.equal(syncs,0);
  h.m._finishScopeRepairGate(h.cid);await done.promise;
  assert.equal(syncs,1);assert.equal(observed.state,'ready');assert.equal(h.m._scopeSyncRequestedAfterRepair.has(h.cid),false);
  assert.deepEqual(h.m.provider.to_bytes(),h.bytes);
 }finally{h.m.destroy();await h.s.close();}
});
test('Ready own committed revision with public cursor progress re-proves without private uncertainty',async()=>{
 const h=await fixture(),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);let checks=0;
 const winner={created_at:'2026-10-12T00:00:00Z',event_id:'public-cursor-winner'};
 h.s.verifyMlsReadyCheckpoint=async cp=>{if(++checks===1)await h.s.saveScopeSyncCursor(h.cid,winner);return verify(cp);};
 const state=await h.m.refreshE2eeState(h.cid);
 assert.equal(state.state,'ready');assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(checks,2);
 assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),winner);
 assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);
 assert.equal((await h.s.loadProviderCheckpoint(h.user,h.device)).revision,h.m._providerDurableBase.revision);
});
test('Ready aborted public readset race rechecks current cursor without poisoning unchanged private state',async()=>{
 const h=await fixture(),save=h.s.saveMlsReadyCheckpoint.bind(h.s);let writes=0;
 const winner={created_at:'2026-10-12T00:00:00Z',event_id:'before-commit-cursor'};
 h.s.saveMlsReadyCheckpoint=async(cp,owner)=>{if(++writes===1)await h.s.saveScopeSyncCursor(h.cid,winner);return save(cp,owner);};
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(writes,2);
 assert.equal(h.m._providerPersistenceUncertain,false);assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),winner);
 assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);
});
test('Ready bounded public readback races retain latest cursor and defer without an infinite retry',async()=>{
 const h=await fixture(),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);let checks=0;
 h.s.verifyMlsReadyCheckpoint=async cp=>{await h.s.saveScopeSyncCursor(h.cid,{created_at:'2026-10-12T00:00:00Z',event_id:'winner-'+(++checks)});return verify(cp);};
 const state=await h.m.refreshE2eeState(h.cid);
 assert.equal(state.state,'repairing');assert.equal(state.reason,'local_checkpoint_pending');assert.equal(checks,2);
 assert.equal(h.m._providerPersistenceUncertain,false);assert.equal((await h.s.loadScopeSyncCursor(h.cid)).event_id,'winner-2');
 assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);assert.equal(h.events.some(e=>e.state==='ready'),false);
 h.s.verifyMlsReadyCheckpoint=verify;assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
});
test('Ready reproof preserves a durable pending winner and never admits Ready over it',async()=>{
 const h=await fixture(),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);let checks=0;const pending={cid:h.cid,accepted:true};
 h.s.verifyMlsReadyCheckpoint=async cp=>{if(++checks===1){const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(pending,'mls_mutation:v1:'+h.cid);tx.oncomplete=yes;tx.onabort=no;});}return verify(cp);};
 const state=await h.m.refreshE2eeState(h.cid);
 assert.equal(state.state,'pending_external_join');assert.equal(state.reason,'mls_mutation_outcome_pending');assert.equal(checks,1);
 assert.equal(h.m._providerPersistenceUncertain,false);assert.equal(h.events.some(e=>e.state==='ready'),false);
 assert.deepEqual((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).cleanup.metadata['mls_mutation:v1:'+h.cid],pending);
 assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);
});
test('Ready cannot rebase to a foreign revision even when the private provider bytes happen to match',async()=>{
 const h=await fixture(),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);let checks=0;
 h.s.verifyMlsReadyCheckpoint=async cp=>{checks++;await h.s.saveProviderState(h.user,h.device,h.bytes,{expected_revision:cp.provider_write_guard.next_revision,next_revision:'foreign-winner'});return verify(cp);};
 assert.equal((await h.m.refreshE2eeState(h.cid)).reason,'provider_persistence_uncertain');assert.equal(checks,1);
 assert.equal(h.m._providerPersistenceUncertain,true);assert.notEqual(h.m._providerDurableBase.revision,'foreign-winner');
 assert.equal((await h.s.loadProviderCheckpoint(h.user,h.device)).revision,'foreign-winner');assert.equal(h.events.some(e=>e.state==='ready'),false);
});
async function restart(h){const n=new EncryptionManager();Object.assign(n,{userId:h.user,deviceId:h.device,storage:new IndexedDBEncryptionStorage(h.user),_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(wasmBytes)});await n._initWasm();await n._initIdentity();await n._restoreGroupsLocally();n.client={activeChannels:{[h.cid]:h.channel}};n.e2eeClient={};n.initialized=true;return n;}
test('Ready observation committed before self-member replacement retires view without poisoning proven private state',async()=>{
 const h=await fixture(),save=h.s.saveMlsReadyCheckpoint.bind(h.s);let changed=false;
 h.s.saveMlsReadyCheckpoint=async(cp,owner)=>{await save(cp,owner);if(!changed){changed=true;h.channel.state.members[h.user]={user_id:h.user,created_at:'2026-10-11T00:00:00Z',name:'new presentation'};}};
 await assert.rejects(h.m.refreshE2eeState(h.cid),e=>e.code==='recovery_scope_changed');
 assert.equal(changed,true);assert.equal(h.m._providerPersistenceUncertain,false);
 assert.equal(h.events.some(e=>e.state==='ready'),false);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);
 assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
});
for(const conflict of ['foreign-revision','read-lost'])test('Ready observation owner replacement preserves uncertainty for '+conflict,async()=>{
 const h=await fixture(),save=h.s.saveMlsReadyCheckpoint.bind(h.s),load=h.s.loadMlsReadyBase.bind(h.s);let changed=false;
 h.s.saveMlsReadyCheckpoint=async(cp,owner)=>{await save(cp,owner);if(!changed){changed=true;h.channel.state.members[h.user]={user_id:h.user,created_at:'2026-10-11T00:00:00Z'};
  if(conflict==='foreign-revision')await h.s.saveProviderState(h.user,h.device,h.bytes,{expected_revision:h.base.revision,next_revision:'foreign-after-observation'});
  else h.s.loadMlsReadyBase=async()=>{throw Error('QA readback unavailable')};}};
 await assert.rejects(h.m.refreshE2eeState(h.cid),e=>e.code==='recovery_scope_changed');
 assert.equal(h.m._providerPersistenceUncertain,true);assert.equal(h.events.some(e=>e.state==='ready'),false);
 h.s.loadMlsReadyBase=load;assert.equal((await h.m.refreshE2eeState(h.cid)).reason,'provider_persistence_uncertain');
});
test('five-state late subscription and semantic dedupe retain reason/revision/generation changes',async()=>{
 const h=await fixture(),seen=[];const sub=h.m.subscribeE2eeState(h.cid,s=>seen.push(s));assert.equal(seen.length,1);assert.equal(seen[0].state,'repairing');
 let state=h.m._commonSnapshot(h.cid,'repairing','storage_checkpoint_failed');h.m._publishCommonState(state);h.m._publishCommonState({...state});assert.equal(seen.length,2);
 for(const extra of [{reason:'invalid_clock'},{recovery_revision:'2'},{group_generation:1}]){state={...state,...extra};h.m._publishCommonState(state);}assert.equal(seen.length,5);
 for(const kind of ['pending_external_join','manual_intervention_required','upgrade_required','ready']){if(kind==='ready')continue;h.m._publishCommonState({...state,state:kind});assert.equal(h.m.getE2eeState(h.cid).state,kind);}
 sub.unsubscribe();const last=[];h.m.subscribeE2eeState(h.cid,s=>last.push(s));assert.equal(last.length,1);assert.equal(last[0].state,'upgrade_required');last[0].reason='mutated';assert.notEqual(h.m.getE2eeState(h.cid).reason,'mutated');
});
test('Ready requires actual tree validation/CAS/full proof before publication and retains private KP',async()=>{const h=await fixture();h.s.verifyMlsReadyCheckpoint=async function(cp){assert.equal(h.events.some(e=>e.state==='ready'),false);return IndexedDBEncryptionStorage.prototype.verifyMlsReadyCheckpoint.call(this,cp);};const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'ready');assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready.provider_revision,state.provider_revision);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);const late=[];h.m.subscribeE2eeState(h.cid,s=>late.push(s));assert.equal(late[0].state,'ready');});
for(const cap of ['readyCheckpointVersion','providerCheckpointCASVersion','loadMlsReadyBase','saveMlsReadyCheckpoint','verifyMlsReadyCheckpoint'])test('missing Ready capability '+cap+' preserves private state',async()=>{const h=await fixture();h.s[cap]=undefined;assert.equal((await h.m.refreshE2eeState(h.cid)).state,'upgrade_required');assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.equal(h.events.some(e=>e.state==='ready'),false);});
test('actual transaction abort keeps active and original durable provider/revision',async()=>{const h=await fixture(),read=h.s._readMlsReadyBase.bind(h.s);h.s._readMlsReadyBase=(tx,...args)=>{read(tx,...args);if(tx.mode==='readwrite')tx.abort();};const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'repairing');assert.equal(h.m._providerPersistenceUncertain,false);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),h.base);assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready,null);});
for(const mode of ['unknown','readback'])test('Ready committed '+mode+' fails closed; restart revalidates exact durable winner',async()=>{const h=await fixture(),save=h.s.saveMlsReadyCheckpoint.bind(h.s),verify=h.s.verifyMlsReadyCheckpoint.bind(h.s);if(mode==='unknown')h.s.saveMlsReadyCheckpoint=async(...args)=>{await save(...args);throw Error('commit outcome unknown');};else h.s.verifyMlsReadyCheckpoint=async cp=>{if(mode==='readback')throw Error('readback lost');await h.s.saveScopeSyncCursor(h.cid,{created_at:'2026-10-12T00:00:00Z',event_id:'winning'});return verify(cp);};assert.equal((await h.m.refreshE2eeState(h.cid)).state,'repairing');assert.equal(h.m._providerPersistenceUncertain,true);assert.equal(h.events.some(e=>e.state==='ready'),false);assert.deepEqual(h.m._activeProvider.to_bytes(),h.bytes);const n=await restart(h);assert.equal((await n.refreshE2eeState(h.cid)).state,'ready');assert.equal(n.identity.owns_key_package_ref(n.provider,h.ref),true);if(mode==='metadata')assert.equal((await n.storage.loadScopeSyncCursor(h.cid)).event_id,'winning');});
for(const kind of ['local','remote','marker','pending','removal'])test('Ready intervening '+kind+' writer cannot overwrite winner',async()=>{const h=await fixture(),save=h.s.saveMlsReadyCheckpoint.bind(h.s);let winning;h.s.saveMlsReadyCheckpoint=async(cp,guard)=>{if(kind==='local'){const kp=h.m.identity.key_package(h.m._activeProvider);kp.free();winning=h.m._activeProvider.to_bytes();}if(kind==='remote'){const p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p);kp.free();winning=p.to_bytes();await h.s.saveProviderState(h.user,h.device,winning,{expected_revision:h.base.revision,next_revision:'winner'});}if(kind==='marker')await h.s.saveGroupState(h.cid,{...h.marker,status:'historical'});if(kind==='pending')await h.s.saveMlsMutationCheckpoint({user_id:h.user,device_id:h.device,cid:h.cid,provider_bytes:h.bytes,marker:h.marker,pending:{cid:h.cid,accepted:true}});if(kind==='removal'){const db=await h.s.openDB();await new Promise((yes,no)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({group_generation:0},'mls_removal:v1:'+h.cid);tx.oncomplete=yes;tx.onabort=no;});}return save(cp,guard);};let state;if(kind==='local')await assert.rejects(h.m.refreshE2eeState(h.cid),e=>e.code==='recovery_scope_changed');else {state=await h.m.refreshE2eeState(h.cid);assert.notEqual(state.state,'ready');}assert.equal(h.events.some(e=>e.state==='ready'),false);assert.deepEqual(h.m._activeProvider.to_bytes(),kind==='local'?winning:h.bytes);if(kind==='remote')assert.deepEqual(await h.s.loadProviderState(h.user,h.device),winning);});
for(const dimension of ['account','device','storage','transport','artifact','group','marker','membership'])test('delayed Ready cannot publish '+dimension+' replacement',async()=>{const h=await fixture(),enter=latch(),release=latch(),save=h.s.saveMlsReadyCheckpoint.bind(h.s);h.s.saveMlsReadyCheckpoint=async(...args)=>{enter.resolve();await release.promise;return save(...args);};const work=h.m.refreshE2eeState(h.cid);await enter.promise;const replacement={replacement:true};if(dimension==='account')h.m.userId='other';if(dimension==='device')h.m.deviceId='other';if(dimension==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);if(dimension==='transport')h.m.e2eeClient=replacement;if(dimension==='artifact')h.m._wasmArtifactSha256='other';if(dimension==='group')h.m.groups.set(h.cid,replacement);if(dimension==='marker')h.m._groupGenerations.set(h.cid,replacement);if(dimension==='membership')h.channel.state.members[h.user]=replacement;release.resolve();await assert.rejects(work);assert.equal(h.events.some(e=>e.state==='ready'),false);assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready,null);});
test('GI uploaded, discovery/control none and initialized cannot create common Ready',async()=>{const h=await fixture();h.m._emitGroupInfoRepairState({cid:h.cid,status:'ready'});assert.equal(h.m.getE2eeState(h.cid),null);h.m._emitSyncState({cid:h.cid,status:'ready',needs_retry:false,has_more:false});assert.equal(h.m.getSyncState(h.cid).status,'needs_retry');assert.equal(h.m._channelReadyUntil.has(h.cid),false);assert.equal(h.events.some(e=>e.state==='ready'),false);});
test('historical marker and unresolved accepted journal cannot cross Ready gate',async()=>{for(const kind of ['historical','journal']){const h=await fixture();if(kind==='historical'){await h.m.leaveGroup(h.cid);}else{await h.s.saveMlsMutationCheckpoint({user_id:h.user,device_id:h.device,cid:h.cid,provider_bytes:h.bytes,marker:h.marker,pending:{cid:h.cid,accepted:true}});const cp=await h.s.loadProviderCheckpoint(h.user,h.device);h.m._providerDurableBase.revision=cp.revision;}assert.notEqual((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(h.events.some(e=>e.state==='ready'),false);}});
test('manual survives restart; same/older/reordered control cannot reopen or extend local retry',async()=>{const h=await fixture(),c=control(h,'4','manual_intervention_required');await h.s.saveRecoveryControlCheckpoint(c);await h.m._loadRecoveryControl(h.cid);assert.equal((await h.m.refreshE2eeState(h.cid)).state,'manual_intervention_required');h.m._scheduleGenerationRecoveryRetry(h.cid,'2027-01-01T00:00:00Z');assert.equal(h.m._generationRecoveryRetries.has(h.cid),false);await h.s.saveRecoveryControlCheckpoint({...c,recovery_revision:'3',recovery_action:'repair'});await h.m._loadRecoveryControl(h.cid);assert.equal(h.m.getE2eeState(h.cid).state,'manual_intervention_required');const n=await restart(h);assert.equal((await n.refreshE2eeState(h.cid)).state,'manual_intervention_required');await h.s.saveRecoveryControlCheckpoint({...c,recovery_revision:'5',recovery_action:'none'});await n._loadRecoveryControl(h.cid);assert.equal((await n.refreshE2eeState(h.cid)).state,'ready');});
test('Ready in repair journals ACK admission without HTTP and preserves bounded admission across repeat/restart',async()=>{const h=await fixture(),c=control(h);c.repair_retry_until=new Date(Date.now()+900000).toISOString();await h.s.saveRecoveryControlCheckpoint(c);let posts=0;h.m.e2eeClient={getGroupInfo:async()=>{posts++;throw Error('offline');},acknowledgeGroupInfoValidation:async()=>{posts++;throw Error('offline');}};assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(posts,0);const prior=await h.s.loadGroupInfoValidationAdmission(h.cid,h.device);assert.equal(prior.attempts,0);assert.equal(prior.outcome,'pending');await h.s.reserveGroupInfoValidationAdmission(prior,Date.now());const reserved=await h.s.loadGroupInfoValidationAdmission(h.cid,h.device);await h.m.refreshE2eeState(h.cid);assert.deepEqual(await h.s.loadGroupInfoValidationAdmission(h.cid,h.device),reserved);const n=await restart(h);await n.refreshE2eeState(h.cid);assert.deepEqual(await n.storage.loadGroupInfoValidationAdmission(h.cid,h.device),reserved);});
test('cleanup racing Ready retires group and invalidates late subscriber/cache proof',async()=>{const h=await fixture();await h.m.refreshE2eeState(h.cid);assert.equal(h.m.getE2eeState(h.cid).state,'ready');await h.m.leaveGroup(h.cid);assert.equal(h.m.getE2eeState(h.cid).state,'repairing');assert.equal((await h.m.refreshE2eeState(h.cid)).state,'repairing');const late=[];h.m.subscribeE2eeState(h.cid,s=>late.push(s));assert.equal(late[0].state,'repairing');});
for(const kind of ['abort','remote','replacement','readback'])test('GI production conditional continuation '+kind+' retains exact durable obligation',async()=>{const h=await fixture(),row={cid:h.cid,request_id:'00000000-0000-4000-8000-000000000002',minimum_epoch:0,reason:'group_info_invalid',deadline_at:new Date(Date.now()+60000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),attempt_count:1};await h.s.saveGroupInfoRefreshRequest(row);const checkpoint=await h.m._captureGroupInfoCheckpoint(h.cid);const save=h.s.saveGroupInfoRefreshCheckpoint.bind(h.s);if(kind==='abort'){h.s.saveGroupInfoRefreshCheckpoint=async(...args)=>{const old=h.s._readMlsReadyBase.bind(h.s);h.s._readMlsReadyBase=(tx,...rest)=>{old(tx,...rest);if(tx.mode==='readwrite')tx.abort();};try{return await save(...args);}finally{h.s._readMlsReadyBase=old;}};}if(kind==='remote'){await h.s.saveGroupInfoRefreshRequest({...row,request_id:'00000000-0000-4000-8000-000000000003'});}if(kind==='replacement')h.channel.state.members[h.user]={replacement:true};if(kind==='readback'){const db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false,proofFailed=false;db.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite')tx.addEventListener('complete',()=>committed=true);if(args[1]==='readonly'&&committed&&!proofFailed){proofFailed=true;queueMicrotask(()=>tx.abort());}return tx;};}await assert.rejects(checkpoint(()=>[]));const rows=await h.s.listGroupInfoRefreshRequests();assert.equal(rows.length,kind==='readback'?0:kind==='remote'?2:1);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.equal(h.events.some(e=>e.state==='ready'),false);});
test('another owned group/provider checkpoint invalidates common Ready before its listener can reuse cache',async()=>{const h=await fixture(),seen=[];await h.m.refreshE2eeState(h.cid);h.m.subscribeE2eeState(h.cid,s=>seen.push(s));const kp=h.m.identity.key_package(h.m.provider);kp.free();await h.m._saveEncryptionSyncCheckpoint();assert.equal(h.m.getE2eeState(h.cid).state,'repairing');assert.equal(seen.at(-1).state,'repairing');assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');});
test('provider queue overload returns typed defer without dropping group or Ready work obligation',async()=>{const h=await fixture();h.m._providerMutationQueued=32;const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'repairing');assert.equal(state.reason,'provider_mutation_busy');assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready,null);h.m._providerMutationQueued=0;assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');});

test('actual owned cold-start replay progress awaits owner then proves public Ready without another RPC',async()=>{
 const h=await fixture(),gate=latch();let calls=0;h.m.client._waitForHydratedColdStartSync=()=>gate.promise;
 const cursor={created_at:'2026-10-11T00:00:01Z',event_id:'00000000-0000-4000-8000-000000000001'};
 await h.s.saveScopeSyncCursor(h.cid,cursor);h.m.e2eeClient.scopeSync=async()=>{calls++;throw Error('duplicate replay');};
 const work=h.m.ensureChannelReady('team',h.cid.slice(5),h.cid,{source:'open'});await new Promise(r=>setImmediate(r));
 assert.equal(h.events.some(e=>e.type==='e2ee.channel_ready'),false);
 h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));assert.equal(h.m.getSyncState(h.cid).status,'needs_retry');gate.resolve();
 const result=await work;assert.equal(result.status,'ready');assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(calls,0);
 assert.equal(h.events.filter(e=>e.type==='e2ee.channel_ready').length,1);
});
test('completed replay progress cannot survive cleanup or replacement to admit Ready',async()=>{
 const h=await fixture(),cursor={created_at:'2026-10-11T00:00:01Z',event_id:'00000000-0000-4000-8000-000000000001'};
 h.m._emitSyncState(h.m._makeSyncState(h.cid,'ready',cursor,cursor));assert.ok(h.m._getCompletedSyncProgress(h.cid));
 h.m._mlsCleanupRevisions.set(h.cid,1);assert.equal(h.m._getCompletedSyncProgress(h.cid),null);assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
});

test('late subscription after durable pending journal restoration reports pending before any async Ready attempt',async()=>{
 const h=await fixture(),guard=h.m._captureMlsPreparation(h.cid);
 await h.m._prepareMlsMutation(h.cid,guard,(provider,g)=>{const b=g.self_update(provider,h.m.identity);return{group:g,marker:h.marker,commit:b.commit,ghosts:[],expected_epoch:0,request:{kind:'rotation',channel_type:'team',channel_id:h.user,target_user_ids:[],body:{}}};});
 const n=await restart(h),seen=[];n.subscribeE2eeState(h.cid,state=>seen.push(state));assert.equal(seen[0].state,'pending_external_join');assert.equal(seen[0].reason,'mls_mutation_outcome_pending');assert.equal((await n.refreshE2eeState(h.cid)).state,'pending_external_join');
});

test('Ready promise sharing excludes old membership owner; old result cannot publish replacement scope',async()=>{
 const h=await fixture(),gate=latch(),entered=latch(),cursor={created_at:'2026-10-11T00:00:01Z',event_id:'00000000-0000-4000-8000-000000000001'};let calls=0;
 h.m._syncChannelFromCursor=async()=>{if(++calls===1){entered.resolve();await gate.promise;}return h.m._makeSyncState(h.cid,'ready',cursor,cursor);};
 const old=h.m.ensureChannelReady('team',h.cid.slice(5),h.cid);const rejected=assert.rejects(old,e=>e.code==='recovery_scope_changed');await entered.promise;
 h.channel.state.members[h.user]={user_id:h.user,created_at:'2026-10-12T00:00:00Z'};
 const fresh=await h.m.ensureChannelReady('team',h.cid.slice(5),h.cid);assert.equal(fresh.status,'ready');assert.equal(calls,2);gate.resolve();await rejected;assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.events.filter(e=>e.type==='e2ee.channel_ready').length,1);
});

test('nonzero local generation without authoritative binding stays typed deferred despite actual usable MLS bytes',async()=>{
 const h=await fixture(),marker={...h.marker,group_generation:1,group_id:h.group.group_id()};h.m._groupGenerations.set(h.cid,marker);await h.m._writeMlsMutation(h.cid,null);
 const state=await h.m.refreshE2eeState(h.cid);assert.equal(state.state,'repairing');assert.equal(state.reason,'mls_generation_binding_pending');assert.equal(h.events.some(e=>e.state==='ready'),false);assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready,null);
});

async function secondGroup(h){
 const cid=h.cid+'-second',group=wasm.Group.create_with_cid(h.m.provider,h.m.identity,cid),marker={...h.marker,cid};
 h.m.groups.set(cid,group);h.m._groupGenerations.set(cid,marker);h.m.client.activeChannels[cid]={data:{mls_enabled:true},state:{members:{[h.user]:{user_id:h.user,created_at:'2026-10-11T00:00:00Z'}}}};
 await h.m._writeMlsMutation(cid,null);return cid;
}
test('real multi-group Ready observations retain provider revision and both exact proofs',async()=>{
 const h=await fixture(),other=await secondGroup(h),before=await h.s.loadProviderCheckpoint(h.user,h.device);
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
 assert.equal((await h.m.refreshE2eeState(other)).state,'ready');
 assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.m.getE2eeState(other).state,'ready');
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);
 assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready.provider_revision,before.revision);
 assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,other)).ready.provider_revision,before.revision);
});
test('real provider mutation invalidates before subscribed listener access and re-admits without revision ping-pong',async()=>{
 const h=await fixture(),other=await secondGroup(h);await h.m.refreshE2eeState(h.cid);await h.m.refreshE2eeState(other);
 const seen=[];let staleReady=false;
 h.m.subscribeE2eeState(h.cid,s=>{seen.push(s.state);if(s.state==='repairing'&&h.m.getE2eeState(h.cid).state==='ready')staleReady=true;});
 h.m.subscribeE2eeState(other,()=>{});
 const kp=h.m.identity.key_package(h.m.provider);kp.free();await h.m._saveEncryptionSyncCheckpoint();
 const committed=await h.s.loadProviderCheckpoint(h.user,h.device);
 // Drain the actual coalesced continuation, not an arbitrary timer/retry loop.
 await h.m._subscribedReadyRevalidation;
 assert.equal(staleReady,false);assert.ok(seen.includes('repairing'));assert.equal(seen.at(-1),'ready');
 assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.m.getE2eeState(other).state,'ready');
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),committed);assert.equal(h.m._providerPersistenceUncertain,false);
});

for(const mode of ['unsubscribe','membership','manual','destroy'])test('subscribed re-admission respects '+mode+' before queue release',async()=>{
 const h=await fixture();await h.m.refreshE2eeState(h.cid);const seen=[];
 const sub=h.m.subscribeE2eeState(h.cid,s=>{seen.push(s.state);if(s.state==='repairing'){
  if(mode==='unsubscribe')sub.unsubscribe();
  if(mode==='membership')h.channel.state.members[h.user]={user_id:h.user,created_at:'replacement'};
  if(mode==='manual')h.m._recoveryControls.set(h.cid,control(h,'9','manual_intervention_required'));
 }});
 const kp=h.m.identity.key_package(h.m.provider);kp.free();await h.m._saveEncryptionSyncCheckpoint();
 const work=h.m._subscribedReadyRevalidation;
 if(mode==='destroy'){h.m.destroy();}
 await work;
 assert.notEqual(seen.at(-1),'ready');
 if(mode!=='destroy')assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
});
test('Ready observation rejects a forged private revision and v2 fallback still writes fresh CAS revision',async()=>{
 const h=await fixture(),save=h.s.saveMlsReadyCheckpoint.bind(h.s);let captured;
 h.s.saveMlsReadyCheckpoint=async(cp,owner)=>{captured=structuredClone(cp);return save(cp,owner);};
 await h.m.refreshE2eeState(h.cid);assert.equal(captured.provider_observation,true);
 const before=await h.s.loadProviderCheckpoint(h.user,h.device);
 const forged=structuredClone(captured);forged.provider_write_guard.next_revision='forged';forged.snapshot.provider_revision='forged';
 await assert.rejects(save(forged,()=>{}),/revision invalid/);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);
 Object.defineProperty(h.s,'readyObservationVersion',{value:undefined});
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');assert.equal(captured.provider_observation,undefined);
 assert.notEqual((await h.s.loadProviderCheckpoint(h.user,h.device)).revision,before.revision);
});

test('an unowned native handle replacement cannot inherit a queued Ready continuation',async()=>{
 const h=await fixture(),entered=latch(),gate=latch(),seen=[];await h.m.refreshE2eeState(h.cid);h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
 const write=h.m._withProviderMutation(async(provider,assertCurrent)=>{const kp=h.m.identity.key_package(provider);kp.free();const bytes=provider.to_bytes(),guard=h.m._providerWriteGuard();await h.s.saveProviderState(h.user,h.device,bytes,guard);assertCurrent();await h.m._readProviderWrite(bytes,guard,assertCurrent);entered.resolve();await gate.promise;});
 await entered.promise;h.m.groups.set(h.cid,wasm.Group.load(h.m._activeProvider,h.cid));gate.resolve();await write;await h.m._subscribedReadyRevalidation;
 assert.notEqual(seen.at(-1),'ready');assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');assert.equal(h.m._providerPersistenceUncertain,false);
});

async function profileFixture(){
 const h=await fixture(),c=new ErmisChat('fixture-key','fixture-project','http://fixture.invalid',{browser:false,logger:()=>{}});
 c._setUser({id:h.user,name:'same profile'});c.deviceId=h.device;
 await c.tokenManager.setTokenOrProvider('fixture-token',{id:h.user});
 c.encryptionManager=h.m;h.m.client=c;
 const channel=c.channel('team',h.user);channel.initialized=true;channel.data={mls_enabled:true,type:'team'};
 channel.state.membership={user:{id:h.user,name:'same profile'},channel_role:'member',created_at:'2026-10-11T00:00:00Z'};
 channel.state.members[h.user]=channel.state.membership;
 h.channel=channel;h.c=c;
 assert.equal((await h.m.refreshE2eeState(h.cid)).state,'ready');
 return h;
}
const drainPresentation=h=>Promise.resolve().then(async()=>{await h.m._subscribedReadyRevalidation;});
test('self profile enrichment coalesces actual native Ready reproof without HTTP, cursor or private KeyPackage changes',async()=>{
 const h=await profileFixture(),seen=[];
 h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
 const prior=h.m._commonStates.get(h.cid),base=await h.s.loadProviderCheckpoint(h.user,h.device),cursor=await h.s.loadScopeSyncCursor(h.cid);
 let proofs=0;const refresh=h.m.refreshE2eeState.bind(h.m);h.m.refreshE2eeState=async(...args)=>{proofs++;return refresh(...args);};
 for(let n=0;n<3;n++)h.c._updateMemberWatcherReferences({id:h.user,name:'same profile'});
 assert.throws(()=>prior.proof(),e=>e.code==='recovery_scope_changed');
 assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');
 await drainPresentation(h);
 assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(seen.at(-1),'ready');assert.ok(seen.includes('repairing'));assert.equal(proofs,1);
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),base);assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),cursor);
 assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);
});
test('other member profile enrichment does not enqueue or retire self Ready',async()=>{
 const h=await profileFixture();h.m.subscribeE2eeState(h.cid,()=>{});h.channel.state.members.other={user:{id:'other'}};
 h.c._updateMemberWatcherReferences({id:'other',name:'other profile'});await drainPresentation(h);
 assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(h.m._subscribedReadyRevalidation,null);
});
for(const mode of ['unsubscribe','route','membership','destroy','manual'])test('self profile Ready wake respects '+mode+' while actual provider writer is pending',async()=>{
 const h=await profileFixture(),seen=[],entered=latch(),gate=latch();
 const sub=h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
 const writer=h.m._withProviderMutation(async()=>{entered.resolve();await gate.promise;});const settled=writer.catch(()=>{});
 await entered.promise;h.c._updateMemberWatcherReferences({id:h.user,name:'same profile'});
 const work=h.m._subscribedReadyRevalidation;
 if(mode==='unsubscribe')sub.unsubscribe();
 if(mode==='route')h.c.baseURL='http://replacement.invalid';
 if(mode==='membership')h.channel.state.members[h.user]={user:{id:h.user},created_at:'replacement'};
 if(mode==='manual')h.m._recoveryControls.set(h.cid,control(h,'9','manual_intervention_required'));
 if(mode==='destroy')h.m.destroy();
 gate.resolve();await settled;await work;
 assert.notEqual(seen.at(-1),'ready');
 if(mode!=='destroy')assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');
});

test('normal channel query replacing the self member readset wakes a fresh local Ready proof',async()=>{
 const h=await profileFixture(),seen=[];let sub;try{
  sub=h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
  const prior=h.m._commonStates.get(h.cid),base=await h.s.loadProviderCheckpoint(h.user,h.device),cursor=await h.s.loadScopeSyncCursor(h.cid);let proofs=0;
  const refresh=h.m.refreshE2eeState.bind(h.m);h.m.refreshE2eeState=async(...args)=>{proofs++;return refresh(...args)};
  for(let n=0;n<3;n++)h.channel._initializeState({channel:{cid:h.cid,type:'team',id:h.user,mls_enabled:true,members:[structuredClone(h.channel.state.members[h.user])]},membership:structuredClone(h.channel.state.membership),messages:[],pinned_messages:[]});
  assert.throws(()=>prior.proof(),e=>e.code==='recovery_scope_changed');assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');
  await drainPresentation(h);assert.equal(h.m.getE2eeState(h.cid).state,'ready');assert.equal(seen.at(-1),'ready');assert.equal(proofs,1);
  assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),base);assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),cursor);assert.deepEqual(h.m.provider.to_bytes(),h.bytes);
 }finally{sub?.unsubscribe();h.m.destroy();await h.s.close();}
});

for(const stop of ['unsubscribe','route','manual'])test('normal query readset wake keeps '+stop+' guard while the provider is held',async()=>{
 const h=await profileFixture(),seen=[],entered=latch(),release=latch();let writer,sub;try{
  sub=h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
  writer=h.m._withProviderMutation(async()=>{entered.resolve();await release.promise});await entered.promise;
  h.channel._initializeState({channel:{cid:h.cid,type:'team',id:h.user,mls_enabled:true,members:[structuredClone(h.channel.state.members[h.user])]},membership:structuredClone(h.channel.state.membership),messages:[],pinned_messages:[]});
  if(stop==='unsubscribe')sub.unsubscribe();if(stop==='route')h.c.baseURL='http://replacement.invalid';
  if(stop==='manual')h.m._recoveryControls.set(h.cid,control(h,'9','manual_intervention_required'));
  release.resolve();await writer;await drainPresentation(h);assert.notEqual(h.m.getE2eeState(h.cid)?.state,'ready');assert.notEqual(seen.at(-1),'ready');
 }finally{release.resolve();if(writer)await writer;sub?.unsubscribe();h.m.destroy();await h.s.close();}
});

for(const entry of ['subscribe-after-install','member-readset-after-install'])test(`newly installed local group without common snapshot reaches normal subscribed Ready: ${entry}`,async()=>{
 const h=await fixture(),seen=[],group=h.m.groups.get(h.cid),before=await h.s.loadProviderCheckpoint(h.user,h.device),cursor=await h.s.loadScopeSyncCursor(h.cid);
 assert.equal(h.m.getE2eeState(h.cid),null);assert.equal(h.m._commonStates.has(h.cid),false);
 if(entry==='member-readset-after-install')h.m.groups.delete(h.cid);
 const sub=h.m.subscribeE2eeState(h.cid,s=>seen.push(s.state));
 if(entry==='member-readset-after-install'){h.m.groups.set(h.cid,group);h.m.handleSelfMemberReadSetUpdated([h.cid]);}
 await drainPresentation(h);
 assert.equal(h.m.getE2eeState(h.cid)?.state,'ready');assert.equal(seen.at(-1),'ready');
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);assert.deepEqual(await h.s.loadScopeSyncCursor(h.cid),cursor);
 assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);assert.equal(h.m._providerPersistenceUncertain,false);
 sub.unsubscribe();await h.s.close();
});
