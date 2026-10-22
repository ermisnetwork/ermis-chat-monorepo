import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';
const {EncryptionManager, IndexedDBEncryptionStorage, sha256Hex,selectRecoveryControl} = createRequire(import.meta.url)('../dist/index.cjs');
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const binary = fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url));
await init({module_or_path: binary}); let sequence = 0;
const latch = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve};};
const enc = encodeURIComponent;
async function fixture(count = 1) {
  const user = 'owned-control-' + ++sequence, device = 'device', s = new IndexedDBEncryptionStorage(user), m = new EncryptionManager(), cids = [], events = [];
  Object.assign(m, {userId:user, deviceId:device, storage:s, _injectedWasm:wasm, _wasmArtifactSha256:sha256Hex(binary)});
  await m._initWasm(); await m._initIdentity();
  m.client = {activeChannels:{}, dispatchEvent:e => events.push(e)};
  for (let i = 0; i < count; i++) {
    const cid = 'team:' + user + '-' + String(i).padStart(3, '0'), group = wasm.Group.create_with_cid(m.provider, m.identity, cid);
    cids.push(cid); m.groups.set(cid, group);
    m._groupGenerations.set(cid, {cid, group_generation:0, group_id:null, current_epoch:0, status:'active', updated_at:1});
    await s.saveGroupState(cid, m._groupGenerations.get(cid));
    m.client.activeChannels[cid] = {data:{mls_enabled:true}, state:{members:{[user]:{user_id:user, created_at:'2026-10-15T00:00:00Z'}}}};
    await s.saveRecoveryControlCheckpoint({version:1, user_id:user, device_id:device, cid,
      signing_identity_sha256:sha256Hex(m.identity.signature_public_key()), group_generation:0,
      incident_id:'00000000-0000-4000-8000-000000000001', recovery_action:'repair', recovery_revision:'1',
      repair_retry_until:new Date(Date.now() + 900000).toISOString()});
    await m._loadRecoveryControl(cid);m._channelE2ee.set(cid,{cid,group_generation:0,group_id:null,epoch:0,group_info:{status:'validation_required',ready:false,epoch:0,last_uploaded_at:null,refresh_requested:false}});
  }
  const kp = m.identity.key_package(m.provider), ref = kp.hash_ref(m.provider); kp.free();
  await m._persistProviderStrict(); m.initialized = true; m._armValidationAckRetry = () => {};
  let gets = 0, posts = 0, discoveries = 0, observations = 0;
  m.e2eeClient = {
    getGroupInfo:async (_type, id) => {gets++; const cid = 'team:' + id, bytes = m.groups.get(cid).export_group_info(m.provider, m.identity, true);
      return {group_info:bytes, epoch:0, group_generation:0, group_id:null, hash:sha256Hex(bytes), is_stale:false};},
    acknowledgeGroupInfoValidation:async () => {posts++; return {accepted:true, idempotent:false, recovery_action:'none', recovery_revision:'9'};},
    discoverMlsRecovery:async batch => {discoveries++; return {protocol_version:1, capability:{protocol_version:1}, states:Object.fromEntries(batch.map(cid => [cid,
      {result:'state', generation:{group_generation:0, group_id:null, current_epoch:0, membership_version:'1', state:'ready', reason:'group_info_missing', retryable:true}, group_info_refresh:null}]))};},
    observeGroupInfoRefresh:async () => {observations++; return {request:null};}, reserveGroupInfoRefreshClaim:async () => {assert.fail('unexpected claim');}, submitReservedGroupInfo:async () => {assert.fail('unexpected upload');},
  };
  const cid = cids[0], c = m._getRecoveryDiscoveryCoordinator(); c.arm = () => {};
  const gi = m._createDurableGroupInfoRepair(); m._groupInfoRepair = gi; gi.arm = () => {};
  const bytes = m.provider.to_bytes(), base = await s.loadProviderCheckpoint(user, device);
  return {m,s,user,device,cid,cids,events,ref,bytes,base,gi,get gets(){return gets;},get posts(){return posts;},get discoveries(){return discoveries;},get observations(){return observations;}};
}
async function put(h, key, value) {const db = await h.s.openDB(); await new Promise((yes,no) => {const tx = db.transaction('meta','readwrite');
  value === undefined ? tx.objectStore('meta').delete(key) : tx.objectStore('meta').put(value,key); tx.oncomplete = yes; tx.onabort = () => no(tx.error);});}
async function get(h, key) {const db = await h.s.openDB(); return new Promise((yes,no) => {const tx=db.transaction('meta','readonly'), r=tx.objectStore('meta').get(key);tx.oncomplete=()=>yes(r.result??null);tx.onabort=()=>no(tx.error);});}
async function dispositions(h) {const db = await h.s.openDB(), prefix = `recovery_work_disposition:v1:${enc(h.device)}:`;
  return new Promise((yes,no) => {const tx=db.transaction('meta','readonly'),r=tx.objectStore('meta').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));tx.oncomplete=()=>yes(r.result);tx.onabort=()=>no(tx.error);});}
async function ack(h, cid = h.cid) {const old = h.m._validationAckAdmissionWork; h.m._validationAckAdmissionWork=Promise.resolve();
  try{await h.m.validateAndQueueGroupInfoAck('team',cid.slice(5),cid);}finally{h.m._validationAckAdmissionWork=old;}
  return h.s.loadGroupInfoValidationAckCheckpoint(cid,h.device);}
async function seed(h,lane,cid=h.cid) {
  let row, primary, due;
  if(lane==='discovery') {const c=h.m._getRecoveryDiscoveryCoordinator();c.arm=()=>{};await c.enqueue([cid]);row=(await h.s.loadRecoveryDiscoveryWork(h.device,[cid]))[cid];primary=`mls_discovery:v1:${enc(h.device)}:${enc(cid)}`;due=`mls_discovery_due:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  if(lane==='gi'||lane==='legacy_gi') {const request={request_id:crypto.randomUUID(),minimum_epoch:0,deadline_at:new Date(Date.now()+600000).toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),reason:'group_info_stale',attempt_count:0,group_generation:0};
    await h.gi.applyAuthoritativeSnapshot({[cid]:request});primary=`gi_work:v1:${enc(h.device)}:${enc(cid)}:${enc(request.request_id)}`;row=await get(h,primary);due=`gi_work_due:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}:${enc(request.request_id)}`;
    if(lane==='legacy_gi'){primary=`group_info_refresh:v1:${cid}:${request.request_id}`;row=await get(h,primary);due=primary;}}
  if(lane==='admission') {await h.m.refreshE2eeState(cid);row=await h.s.loadGroupInfoValidationAdmission(cid,h.device);primary=`gi_validation_admission:v1:${enc(h.device)}:${enc(cid)}`;due=`gi_validation_admission_pending:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  if(lane==='ack') {row=await ack(h,cid);primary=`gi_validation_ack:v1:${enc(h.device)}:${enc(cid)}`;due=`gi_validation_ack_pending:v1:${enc(h.device)}:${String(row.retry_at).padStart(16,'0')}:${enc(cid)}`;}
  return {row,primary,due};
}
async function privatePreserved(h) {assert.deepEqual(h.m.provider.to_bytes(),h.bytes);assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);}


const state=(h,revision='2',action='manual_intervention_required',id=null)=>({group_generation:id?1:0,group_id:id,current_epoch:0,membership_version:'1',state:'repairing',reason:'group_info_invalid',retryable:true,
 incident_id:'00000000-0000-4000-8000-000000000001',recovery_action:action,recovery_revision:revision,repair_retry_until:new Date(Date.now()+900000).toISOString(),capability:{protocol_version:1,automatic_enabled:false}});

for(const fault of ['provider','identity'])test('control cannot publish a manual/reopen response under a changed durable '+fault+' owner',async()=>{
 const h=await fixture();await h.m.refreshE2eeState(h.cid);const seen=[];h.m.subscribeE2eeState(h.cid,v=>seen.push(v));const before=await h.s.loadRecoveryControlCheckpoint(h.cid,h.device);
 const p=wasm.Provider.from_bytes(h.m._activeProvider.to_bytes()),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p),ref=kp.hash_ref(p);kp.free();
 if(fault==='provider'){const b=await h.s.loadProviderCheckpoint(h.user,h.device);await h.s.saveProviderState(h.user,h.device,p.to_bytes(),{expected_revision:b.revision,next_revision:crypto.randomUUID()});}
 else await h.s.saveIdentity(h.user,h.device,new Uint8Array([9,8,7]));
 const winner=await h.s.loadProviderCheckpoint(h.user,h.device);await assert.rejects(h.m._applyRecoveryControl(h.cid,state(h)));
 assert.deepEqual(await h.s.loadRecoveryControlCheckpoint(h.cid,h.device),before);assert.equal(h.m._recoveryControls.get(h.cid).recovery_action,'repair');
 assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.notEqual(seen.at(-1).state,'ready');
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);assert.equal(i.owns_key_package_ref(p,ref),true);i.free();p.free();await h.s.close();
});

test('numeric nonzero control without canonical GroupId cannot publish Ready',async()=>{
 const h=await fixture(),id=new Uint8Array([34,56,78]),g=wasm.Group.create_with_group_id(h.m._activeProvider,h.m.identity,id);
 h.m.groups.set(h.cid,g);const marker={...h.m._groupGenerations.get(h.cid),group_generation:1,group_id:id};h.m._groupGenerations.set(h.cid,marker);await h.s.saveGroupState(h.cid,marker);
 const control={...h.m._recoveryControls.get(h.cid),group_generation:1};await h.s.saveRecoveryControlCheckpoint(control);await h.m._loadRecoveryControl(h.cid);await h.m._persistProviderStrict();
 const result=await h.m.refreshE2eeState(h.cid);assert.equal(result.state,'repairing');assert.equal(result.reason,'mls_generation_binding_pending');assert.equal((await h.s.loadMlsReadyBase(h.user,h.device,h.cid)).ready,null);await h.s.close();
});

async function explicit(h){const id=new Uint8Array([34,56,79]),g=wasm.Group.create_with_group_id(h.m._activeProvider,h.m.identity,id),marker={...h.m._groupGenerations.get(h.cid),group_generation:1,group_id:id};
 h.m.groups.set(h.cid,g);h.m._groupGenerations.set(h.cid,marker);await h.s.saveGroupState(h.cid,marker);const control={...h.m._recoveryControls.get(h.cid),group_generation:1};
 await h.s.saveRecoveryControlCheckpoint(control);await h.m._loadRecoveryControl(h.cid);await h.m._persistProviderStrict();return{id,g,marker};}

for(const fault of ['abort','readback','unknown','control_replacement','marker_replacement','ack_replacement','private_replacement'])test('owned control '+fault+' cannot publish an unproved manual/reopen or overwrite the winner',async()=>{
 const h=await fixture(),prior=await h.s.loadMlsReadyBase(h.user,h.device,h.cid),save=h.s.saveRecoveryControlWork.bind(h.s),db=await h.s.openDB(),original=db.transaction.bind(db);let committed=false,winner;
 h.s.saveRecoveryControlWork=async(...args)=>{
  if(fault==='unknown'){await save(...args);throw Error('control commit acknowledgement lost');}
  db.transaction=(...a)=>{const tx=original(...a);if(a[1]==='readwrite'){
   if(fault==='abort')queueMicrotask(()=>tx.abort());else tx.addEventListener('complete',()=>{committed=true;
    if(fault.endsWith('_replacement')){const t=original(['meta','groups'],'readwrite');
     if(fault==='control_replacement'){winner={...prior.control,recovery_revision:'9',recovery_action:'repair'};t.objectStore('meta').put(winner,`recovery_control:v1:${enc(h.device)}:${enc(h.cid)}`);}
     if(fault==='marker_replacement'){winner={...prior.cleanup.marker,status:'historical'};t.objectStore('groups').put(winner,h.cid);}
     if(fault==='ack_replacement'){winner={version:99,foreign:'ACK obligation'};t.objectStore('meta').put(winner,`gi_validation_ack:v1:${enc(h.device)}:${enc(h.cid)}`);}
     if(fault==='private_replacement'){const p=wasm.Provider.from_bytes(h.bytes),i=wasm.Identity.from_bytes(p,h.m.identity.to_bytes()),kp=i.key_package(p);kp.free();winner={provider_bytes:p.to_bytes(),revision:crypto.randomUUID()};t.objectStore('meta').put(winner.provider_bytes,`provider:${h.user}:${h.device}`);t.objectStore('meta').put(winner.revision,`provider_revision:${h.user}:${h.device}`);i.free();p.free();}
    }
   });
  }if(a[1]==='readonly'&&committed&&fault==='readback')queueMicrotask(()=>tx.abort());return tx;};
  try{return await save(...args);}finally{db.transaction=original;}
 };
 const beforeEvents=h.events.length;await assert.rejects(h.m._applyRecoveryControl(h.cid,state(h)));db.transaction=original;
 assert.equal(h.m._recoveryControls.get(h.cid).recovery_action,'repair');assert.equal(h.events.slice(beforeEvents).some(e=>e.state==='manual_intervention_required'),false);
 const actual=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);
 if(fault==='abort')assert.deepEqual(actual,prior);
 else if(fault==='control_replacement')assert.deepEqual(actual.control,winner);else assert.equal(actual.control.recovery_action,'manual_intervention_required');
 if(fault==='marker_replacement')assert.deepEqual(actual.cleanup.marker,winner);if(fault==='ack_replacement')assert.deepEqual(actual.ack,winner);
 if(fault==='private_replacement')assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),winner);
 else{assert.deepEqual(actual.provider_bytes,prior.provider_bytes);assert.equal(actual.revision,prior.revision);}
 assert.equal(h.m._providerPersistenceUncertain,fault==='private_replacement');assert.equal(h.posts,0);await h.s.close();
});

for(const scope of ['account','device','storage','identity','transport','artifact','provider','base','group','marker','control','pending'])test('held authoritative control rejects '+scope+' replacement without finishing old work',async()=>{
 const h=await fixture(),before=await h.s.loadRecoveryControlCheckpoint(h.cid,h.device),entered=latch(),gate=latch(),load=h.s.loadMlsReadyBase.bind(h.s);
 h.s.loadMlsReadyBase=async(...args)=>{entered.resolve();await gate.promise;return load(...args);};const work=h.m._applyRecoveryControl(h.cid,state(h)),rejected=assert.rejects(work);await entered.promise;
 if(scope==='account')h.m.userId='other';if(scope==='device')h.m.deviceId='other';if(scope==='storage')h.m.storage=new IndexedDBEncryptionStorage(h.user);if(scope==='identity')h.m.identity=wasm.Identity.from_bytes(h.m._activeProvider,h.m.identity.to_bytes());
 if(scope==='transport')h.m.e2eeClient={};if(scope==='artifact')h.m._wasmArtifactSha256='f'.repeat(64);if(scope==='provider')h.m._activeProvider=wasm.Provider.from_bytes(h.bytes);
 if(scope==='base')h.m._providerDurableBase={...h.m._providerDurableBase};if(scope==='group')h.m.groups.set(h.cid,wasm.Group.load(h.m._activeProvider,h.cid));
 if(scope==='marker')h.m._groupGenerations.set(h.cid,{...h.m._groupGenerations.get(h.cid),updated_at:2});if(scope==='control')h.m._recoveryControls.set(h.cid,{...h.m._recoveryControls.get(h.cid),recovery_revision:'9'});
 if(scope==='pending')h.m._pendingMlsMutations.set(h.cid,{operation_id:'winner'});gate.resolve();await rejected;
 assert.deepEqual(await h.s.loadRecoveryControlCheckpoint(h.cid,h.device),before);assert.deepEqual(await h.s.loadProviderState(h.user,h.device),h.bytes);assert.equal(h.events.some(e=>e.state==='manual_intervention_required'),false);await h.s.close();
});

for(const scope of ['storage','account','device'])test('shared scheduling cannot adopt matching private bytes/revision from an unbound '+scope+' base',async()=>{
 const h=await fixture(),job=await seed(h,'ack'),base=h.m._providerDurableBase;
 if(scope==='storage')base.storage=new IndexedDBEncryptionStorage(h.user);if(scope==='account')base.userId='other';if(scope==='device')base.deviceId='other';
 await assert.rejects(h.m._takeValidationWorkPage('ack',Date.now()),e=>e.code==='client_upgrade_required');assert.equal(await get(h,`recovery_work_scan:v1:${enc(h.device)}:ack`),null);
 assert.deepEqual(await get(h,job.primary),job.row);assert.deepEqual(await get(h,job.due),job.row);assert.equal(h.posts,0);await h.s.close();
});

for(const cap of ['recoveryControlWorkCheckpointVersion','saveRecoveryControlWork'])test('missing '+cap+' upgrades before control write or repair Ready and preserves old private state',async()=>{
 const h=await fixture(),before=await h.s.loadMlsReadyBase(h.user,h.device,h.cid);h.s[cap]=undefined;await assert.rejects(h.m._applyRecoveryControl(h.cid,state(h)),e=>e.code==='client_upgrade_required');
 const value=await h.m.refreshE2eeState(h.cid);assert.equal(value.state,'upgrade_required');assert.deepEqual(await h.s.loadMlsReadyBase(h.user,h.device,h.cid),before);await privatePreserved(h);await h.s.close();
});

test('explicit canonical GroupId binds nonzero Ready after full actual MLS validation and survives restart',async()=>{
 const h=await fixture(),{id}=await explicit(h);const before=await h.s.loadProviderCheckpoint(h.user,h.device);
 const control=await h.m._applyRecoveryControl(h.cid,state(h,'2','repair',id));assert.deepEqual(control.group_id,id);assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);
 const value=await h.m.refreshE2eeState(h.cid);assert.equal(value.state,'ready');assert.equal(value.group_generation,1);
 const copy=h.m.getRecoveryControlSnapshot(h.cid);copy.group_id[0]^=255;assert.deepEqual(h.m.getRecoveryControlSnapshot(h.cid).group_id,id);
 const restarted=new EncryptionManager();Object.assign(restarted,{userId:h.user,deviceId:h.device,storage:h.s,_injectedWasm:wasm,_wasmArtifactSha256:sha256Hex(binary),e2eeClient:h.m.e2eeClient,client:h.m.client});await restarted._initWasm();await restarted._initIdentity();await restarted._restoreGroupsLocally();restarted.initialized=true;restarted._armValidationAckRetry=()=>{};
 assert.notEqual(restarted.getE2eeState(h.cid)?.state,'ready');assert.equal((await restarted.refreshE2eeState(h.cid)).state,'ready');assert.deepEqual(restarted.getRecoveryControlSnapshot(h.cid).group_id,id);await h.s.close();
});

test('same revision may fill a legacy missing GroupId once; contradictory binding cannot replace it even at newer revision',async()=>{
 const h=await fixture(),{id}=await explicit(h),prior=await h.s.loadRecoveryControlCheckpoint(h.cid,h.device);
 const full={...prior,group_id:id};assert.deepEqual(selectRecoveryControl(prior,full),full);await h.m._applyRecoveryControl(h.cid,{...state(h,'1','repair',id),repair_retry_until:prior.repair_retry_until});
 const stored=await h.s.loadRecoveryControlCheckpoint(h.cid,h.device);assert.deepEqual(stored,full);
 for(const revision of ['1','2'])await assert.rejects(h.m._applyRecoveryControl(h.cid,{...state(h,revision,'repair',new Uint8Array([99,98])),repair_retry_until:prior.repair_retry_until}),e=>e.code==='recovery_generation_binding_conflict');
 assert.deepEqual(await h.s.loadRecoveryControlCheckpoint(h.cid,h.device),full);assert.equal(h.posts,0);await h.s.close();
});

test('matching numeric generation with another canonical GroupId remains pending without replacing actual private group',async()=>{
 const h=await fixture(),{id}=await explicit(h);await h.m._applyRecoveryControl(h.cid,state(h,'2','repair',new Uint8Array([99,98])));
 const value=await h.m.refreshE2eeState(h.cid);assert.equal(value.reason,'mls_generation_binding_pending');assert.notEqual(value.state,'ready');assert.deepEqual(h.m.groups.get(h.cid).group_id(),id);assert.equal(h.posts,0);await h.s.close();
});

for(const binding of ['canonical','missing','mismatch'])test('nonzero flat publication '+binding+' binding never renames the native private group',async()=>{
 const h=await fixture(),{id}=await explicit(h);try{
  if(binding!=='missing')await h.m._applyRecoveryControl(h.cid,state(h,'2','repair',binding==='canonical'?id:new Uint8Array([2,3])));
  const metadata={cid:h.cid,group_generation:1,group_id:Buffer.from(id).toString('base64'),epoch:0,group_info:{status:'missing',ready:false,epoch:null,last_uploaded_at:null,refresh_requested:true},recovery:null};
  h.m.observeChannelE2ee(metadata);h.m._queueChannelEvidence=()=>{};
  let markers=0,uploads=0;h.m.e2eeClient.getGroupInfoPublicationMarker=async()=>{markers++;return{marker:{group_generation:1,epoch:0,observed_hash:null}};};
  h.m.e2eeClient.submitReservedGroupInfo=async(_t,_i,body)=>{uploads++;assert.deepEqual(body.expected,{group_generation:1,group_id:id});assert.equal(body.lease_token,undefined);};
  const bytes=h.m.provider.to_bytes();await h.m._checkChannelEvidence(h.cid);
  assert.equal(markers,binding==='canonical'?1:0);assert.equal(uploads,binding==='canonical'?1:0);assert.deepEqual(h.m.groups.get(h.cid).group_id(),id);assert.deepEqual(h.m.provider.to_bytes(),bytes);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);
 }finally{h.m.destroy();await h.s.close();}
});

test('uncertain committed manual control fences cached/current/late Ready without poisoning independent private state',async()=>{
 const h=await fixture();await h.m.refreshE2eeState(h.cid);assert.equal(h.m.getE2eeState(h.cid).state,'ready');const seen=[];h.m.subscribeE2eeState(h.cid,v=>seen.push(v));
 const before=await h.s.loadProviderCheckpoint(h.user,h.device),save=h.s.saveRecoveryControlWork.bind(h.s);
 h.s.saveRecoveryControlWork=async(...args)=>{await save(...args);throw Error('unknown result after manual commit');};
 await assert.rejects(h.m._applyRecoveryControl(h.cid,state(h)));assert.equal(h.m._providerPersistenceUncertain,false);
 assert.equal((await h.s.loadRecoveryControlCheckpoint(h.cid,h.device)).recovery_action,'manual_intervention_required');assert.equal(h.m._recoveryControls.get(h.cid).recovery_action,'repair');
 assert.notEqual(h.m.getE2eeState(h.cid).state,'ready');const late=[];h.m.subscribeE2eeState(h.cid,v=>late.push(v));assert.notEqual(late[0].state,'ready');assert.notEqual(seen.at(-1).state,'ready');
 assert.deepEqual(await h.s.loadProviderCheckpoint(h.user,h.device),before);assert.equal((await h.m.refreshE2eeState(h.cid)).state,'manual_intervention_required');await h.s.close();
});

for(const binding of ['canonical','missing','mismatch'])test('nonzero ACK '+binding+' binding defers before GET or validates actual canonical head exactly',async()=>{
 const h=await fixture(),{id}=await explicit(h);
 if(binding!=='missing')await h.m._applyRecoveryControl(h.cid,state(h,'2','repair',binding==='canonical'?id:new Uint8Array([2,3])));
 h.m.e2eeClient.getGroupInfo=async()=>{const bytes=h.m.groups.get(h.cid).export_group_info(h.m._activeProvider,h.m.identity,true);return{group_info:bytes,group_generation:1,group_id:id,epoch:0,hash:sha256Hex(bytes),is_stale:false};};
 if(binding==='canonical'){h.m._channelE2ee.set(h.cid,{...h.m._channelE2ee.get(h.cid),group_generation:1,group_id:Buffer.from(id).toString('base64')});const row=await ack(h);assert.equal(row.request.group_generation,1);await h.m._drainGroupInfoValidationAcks();assert.equal(h.posts,1);assert.equal((await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device)).outcome,'accepted');}
 else{await assert.rejects(ack(h),e=>e.code==='mls_generation_binding_pending');assert.equal(await h.s.loadGroupInfoValidationAckCheckpoint(h.cid,h.device),null);assert.equal(h.posts,0);}
 await h.s.close();
});

test('missing canonical publication binding resumes after owned control without a generic lease job',async()=>{
 const h=await fixture(),{id}=await explicit(h);try{
  h.m._queueChannelEvidence=()=>{};h.m.observeChannelE2ee({cid:h.cid,group_generation:1,group_id:Buffer.from(id).toString('base64'),epoch:0,group_info:{status:'missing',ready:false,epoch:null,last_uploaded_at:null,refresh_requested:true},recovery:null});
  let calls=0;h.m.e2eeClient.getGroupInfoPublicationMarker=async()=>{calls++;return{marker:null};};h.m.e2eeClient.submitReservedGroupInfo=async()=>{calls++;};
  await h.m._checkChannelEvidence(h.cid);assert.equal(calls,0);
  await h.m._applyRecoveryControl(h.cid,state(h,'2','repair',id));await h.m._checkChannelEvidence(h.cid);assert.equal(calls,2);
  assert.deepEqual(await h.s.listGroupInfoRefreshRequests(),[]);assert.deepEqual(h.m.groups.get(h.cid).group_id(),id);assert.equal(h.m.identity.owns_key_package_ref(h.m.provider,h.ref),true);
 }finally{h.m.destroy();await h.s.close();}
});
